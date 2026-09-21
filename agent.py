"""Observe → calculate → retrieve → propose → human approval → verify.

The default agent is a bounded rule-driven agent, not a pretend LLM. Optional
model output is explanatory only; it cannot call equipment or approve orders.
"""
import json
import re
import uuid
from pathlib import Path

import model_client
from store import now
from telemetry import fingerprint, recovery_demo, summarize

KNOWLEDGE = json.loads(Path(__file__).with_name("knowledge.json").read_text(encoding="utf-8"))


class Agent:
    def __init__(self, store):
        self.store = store

    def create_run(self, dataset, task):
        if not isinstance(task, str) or not 1 <= len(task.strip()) <= 1000:
            raise ValueError("请填写 1–1000 字的检查任务。")
        # Recognized PV identifiers are exact, case-insensitive selectors.
        requested = set(re.findall(r"\bPV-\d{2,}\b", task.upper()))
        known = {r["device_id"].upper() for r in dataset["rows"]}
        if requested - known:
            raise ValueError("任务包含数据集中不存在的设备：" + ", ".join(sorted(requested - known)))
        run = {"id": "RUN-" + uuid.uuid4().hex[:10], "status": "running", "created_at": now(), "task": task.strip(), "dataset_id": dataset["id"], "dataset_name": dataset["label"], "source": dataset["source"], "scope": sorted(requested), "trace": [], "proposals": [], "references": [], "model_explanation": None, "model_status": "not_requested"}
        self.store.save_run(run)
        return run

    def step(self, run, tool, title, output):
        run["trace"].append({"index": len(run["trace"]) + 1, "at": now(), "tool": tool, "title": title, "output": output})
        self.store.save_run(run)

    def execute(self, run_id):
        run = self.store.run(run_id)
        try:
            dataset = self.store.dataset(run["dataset_id"])
            rows = [r for r in dataset["rows"] if not run["scope"] or r["device_id"].upper() in run["scope"]]
            self.step(run, "plan_inspection", "确定检查范围", {"scope": run["scope"] or "全部设备", "plan": ["读取并核验遥测", "归一化与连续异常计算", "根据异常检索运维知识", "生成需要人工确认的处理草案"], "execution": "本地只读数据分析；执行动作仅生成草案"})
            self.step(run, "inspect_telemetry", "读取遥测证据", {"records": len(rows), "devices": len({r["device_id"] for r in rows}), "fingerprint": fingerprint(rows), "source": run["source"], "time_range": [min(r["timestamp"] for r in rows), max(r["timestamp"] for r in rows)]})
            metrics = summarize(rows)
            run["analysis"] = metrics
            self.step(run, "normalize_and_detect", "排除天气影响并计算偏差", {"counts": metrics["counts"], "method": "参考直流功率 = 额定功率 × 辐照/1000 × [1 − 0.0035 × (组件温度 − 25)]", "gate": "连续三个有效样本；辐照≥200；归一化功率<78%或交流/直流<87%", "findings": [{"device": f["device_id"], "code": f["code"], "reason": f["reason"]} for f in metrics["findings"]]})
            codes = {f["code"] for f in metrics["findings"]} or {"healthy"}
            references = [k for k in KNOWLEDGE if codes.intersection(k["codes"])]
            run["references"] = references
            self.step(run, "retrieve_handbook", "按异常类型检索运维依据", {"query_codes": sorted(codes), "matched": [{"id": k["id"], "title": k["title"], "source": k["source"]} for k in references], "method": "本地结构化精确检索；手册为项目自编演示资料"})
            for finding in metrics["findings"]:
                if finding["status"] != "alert":
                    continue
                entry = next(k for k in references if finding["code"] in k["codes"])
                device = next(d for d in metrics["devices"] if d["device_id"] == finding["device_id"])
                run["proposals"].append({"id": "DRAFT-" + uuid.uuid4().hex[:8], "device_id": finding["device_id"], "code": finding["code"], "title": "转换侧状态复核" if finding["code"] == "conversion_loss" else "局部发电偏低排查", "reason": finding["reason"], "action": entry["action"], "reference_id": entry["id"], "evidence": finding["evidence"], "metrics": finding["metrics"], "rated_power_w": device["rated_power_w"], "last_anomaly_at": device["timestamp"], "priority": "待运维人员评估", "status": "draft"})
            self.step(run, "draft_work_orders", "生成处置草案", {"draft_count": len(run["proposals"]), "devices": [p["device_id"] for p in run["proposals"]], "approval": "人工确认后才创建本地工单；不向真实设备或人员派发命令"})
            count = metrics["counts"]
            if count["alert"]:
                run["summary"] = f"已检查 {count['total']} 台设备，发现 {count['alert']} 台存在持续偏差，生成 {len(run['proposals'])} 份待确认草案。当前数据支持发现异常，具体故障原因仍需现场核验。"
            elif count["observe"]:
                run["summary"] = f"已检查 {count['total']} 台设备，其中 {count['observe']} 台需要补充观测。当前证据不足以生成维修草案。"
            else:
                run["summary"] = f"已检查 {count['total']} 台设备，天气归一化后未发现达到演示阈值的持续偏差，本次无需生成维修草案。"
            if model_client.configuration()["enabled"]:
                run["model_status"] = "running"
                self.step(run, "explain_with_model", "调用已配置模型补充解释", {"scope": "仅发送任务、测量摘要与匹配手册；模型不能改变工单状态"})
                try:
                    run["model_explanation"] = model_client.explain(run["task"], metrics, metrics["findings"], references)
                    run["model_status"] = "done"
                except Exception:
                    run["model_status"] = "unavailable"
                    run["model_notice"] = "模型接口未成功返回解释；本次本地计算与证据检索已完成。请核对模型地址、凭据和协议。"
            run["status"], run["completed_at"] = "done", now()
            self.store.save_run(run)
        except Exception:
            run["status"], run["error"] = "failed", "检查执行失败，请重新发起或查看本地终端日志。"
            self.store.save_run(run)
            import traceback
            traceback.print_exc()

    def retest(self, order_id, rows=None, demo=False):
        order = next((o for o in self.store.orders() if o["id"] == order_id), None)
        if not order:
            raise ValueError("工单不存在。")
        if order["status"] != "open":
            raise ValueError("该工单已关闭。")
        if demo:
            if order["source"] != "demo":
                raise ValueError("导入数据的工单必须使用新的 CSV 实测数据复测，不能用模拟数据关闭。")
            rows = recovery_demo(order["device_id"], order["last_anomaly_at"], order["rated_power_w"])
        if not rows:
            raise ValueError("请上传复测数据。")
        selected = [r for r in rows if r["device_id"] == order["device_id"]]
        if len(selected) < 3:
            raise ValueError("该设备至少需要 3 条新的复测记录。")
        if any(r["timestamp"] <= order["last_anomaly_at"] for r in selected):
            raise ValueError("所有复测数据必须晚于原异常时间。")
        if any(r["rated_power_w"] != order["rated_power_w"] for r in selected):
            raise ValueError("复测额定功率与原始记录不一致。")
        result = summarize(selected)
        passed = result["devices"][0]["status"] == "healthy"
        record = {"at": now(), "source": "demo" if demo else "csv", "passed": passed, "fingerprint": fingerprint(selected), "analysis": result, "rows": selected, "note": "模拟恢复数据，仅用于验证软件闭环。" if demo else "依据上传数据与演示规则判断；不等于现场维修鉴定。"}
        return self.store.record_retest(order_id, record)


def report(run):
    lines = ["# 见仁建智 绿能运维检查报告", "", f"- 检查编号：{run['id']}", f"- 生成时间：{run['created_at']}", f"- 数据来源：{'模拟演示数据' if run['source'] == 'demo' else '用户导入 CSV'}", f"- 数据集：{run['dataset_name']}", f"- 任务：{run['task']}", f"- 状态：{run['status']}", "", "## 结论", "", run.get("summary", "检查尚未完成。"), "", "## 工具执行记录", ""]
    for step in run["trace"]:
        lines += [f"### {step['index']}. {step['title']} / {step['tool']}", "", f"时间：{step['at']}", "", "```json", json.dumps(step["output"], ensure_ascii=False, indent=2), "```", ""]
    lines += ["## 运维依据", ""]
    for entry in run["references"]:
        lines += [f"- {entry['id']} {entry['title']}（{entry['source']}）：{entry['text']}"]
    lines += ["", "## 工单草案与原始证据", "", "```json", json.dumps(run["proposals"], ensure_ascii=False, indent=2), "```", "", "## 使用边界", "", "本报告使用项目自编演示规则，未对接真实 C-SMART、BIM 或设备控制系统。参考功率为未标定的近似模型，不是发电量保证。不会自动派发真实工单或关闭真实告警。"]
    if run.get("model_explanation"):
        lines += ["", "## 模型辅助解释（需人工复核）", "", run["model_explanation"]]
    return "\n".join(lines)
