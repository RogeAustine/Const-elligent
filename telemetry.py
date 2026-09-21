"""Validated telemetry and transparent, demonstration-only engineering rules."""
import csv
import hashlib
import io
import math
import random
from datetime import datetime, timedelta

FIELDS = ["timestamp", "device_id", "irradiance_wm2", "module_temp_c", "dc_power_w", "ac_power_w", "rated_power_w"]
LIMITS = {"irradiance_wm2": (0, 1600), "module_temp_c": (-40, 110), "dc_power_w": (0, 1000000), "ac_power_w": (0, 1000000), "rated_power_w": (1, 1000000)}
SCENARIOS = {
    "mixed": {"label": "局部发电异常", "description": "局部功率偏低与转换效率异常并存，检查需要处理的设备。"},
    "cloud": {"label": "阴云经过", "description": "日照降低导致全站功率下降，检查是否需要派单。"},
    "normal": {"label": "健康运行", "description": "所有演示设备处于正常区间，检查误报控制。"},
    "lowlight": {"label": "低辐照观察", "description": "辐照不足，当前数据不适合做性能诊断。"},
}


def parse_csv(text):
    if len(text.encode("utf-8")) > 2_000_000:
        raise ValueError("CSV 超过 2 MB，请缩小数据范围。")
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    missing = set(FIELDS) - set(reader.fieldnames or [])
    if missing:
        raise ValueError("CSV 缺少列：" + ", ".join(sorted(missing)))
    rows, seen, rating_map = [], set(), {}
    for number, raw in enumerate(reader, 2):
        if number > 5001:
            raise ValueError("最多导入 5000 行数据。")
        device = (raw.get("device_id") or "").strip()
        if not device or len(device) > 60 or any(ord(c) < 32 for c in device):
            raise ValueError(f"第 {number} 行设备编号无效。")
        try:
            stamp = datetime.fromisoformat((raw.get("timestamp") or "").strip())
        except ValueError:
            raise ValueError(f"第 {number} 行时间必须为 ISO 日期时间。") from None
        if stamp.tzinfo is not None:
            raise ValueError(f"第 {number} 行含时区，请统一转换为项目当地时间并移除时区后导入。")
        key = (device, stamp.isoformat(timespec="seconds"))
        if key in seen:
            raise ValueError(f"第 {number} 行与已有设备时间记录重复。")
        seen.add(key)
        row = {"device_id": device, "timestamp": key[1]}
        for field, (low, high) in LIMITS.items():
            try:
                value = float(raw[field])
            except (ValueError, TypeError):
                raise ValueError(f"第 {number} 行 {field} 必须为数值。") from None
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"第 {number} 行 {field} 必须在 {low}–{high} 之间。")
            row[field] = value
        if row["ac_power_w"] > row["dc_power_w"] + 2:
            raise ValueError(f"第 {number} 行交流功率大于直流功率，请核对测点或单位。")
        if device in rating_map and rating_map[device] != row["rated_power_w"]:
            raise ValueError(f"第 {number} 行同一设备额定功率不一致。")
        rating_map[device] = row["rated_power_w"]
        rows.append(row)
    if not rows:
        raise ValueError("CSV 没有数据行。")
    if len(rating_map) > 100:
        raise ValueError("每次最多分析 100 台设备。")
    return sorted(rows, key=lambda r: (r["timestamp"], r["device_id"]))


def expected_dc(row):
    # Illustrative nameplate normalization, not a calibrated yield model.
    return max(0, row["rated_power_w"] * row["irradiance_wm2"] / 1000 * (1 - 0.0035 * (row["module_temp_c"] - 25)))


def demo_rows(scenario="mixed"):
    if scenario not in SCENARIOS:
        raise ValueError("未知演示场景。")
    rng, rows = random.Random(42), []
    start = datetime(2026, 9, 20, 9, 0)
    for slot in range(12):
        for index in range(1, 9):
            irradiance = 690 + 120 * math.sin(slot / 11 * math.pi)
            if scenario == "cloud" and slot >= 7:
                irradiance *= 0.43
            if scenario == "lowlight":
                irradiance = 90 + slot * 2
            temperature = 25 + irradiance * 0.032
            row = {"timestamp": (start + timedelta(minutes=15 * slot)).isoformat(), "device_id": f"PV-{index:02d}", "irradiance_wm2": round(irradiance, 1), "module_temp_c": round(temperature, 1), "rated_power_w": 500.0}
            ratio, efficiency = rng.uniform(0.96, 1.02), 0.96
            if scenario == "mixed" and slot >= 7:
                if index == 3:
                    ratio = 0.62
                if index == 6:
                    efficiency = 0.76
            row["dc_power_w"] = round(expected_dc(row) * ratio, 2)
            row["ac_power_w"] = round(row["dc_power_w"] * efficiency, 2)
            rows.append(row)
    return rows


def as_csv(rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def fingerprint(rows):
    return hashlib.sha256(as_csv(rows).encode("utf-8")).hexdigest()[:16]


def summarize(rows):
    groups = {}
    for row in sorted(rows, key=lambda r: r["timestamp"]):
        groups.setdefault(row["device_id"], []).append(row)
    devices, findings = [], []
    latest_global = max(datetime.fromisoformat(r["timestamp"]) for r in rows)
    for device, series in sorted(groups.items()):
        latest = series[-1]
        dc = expected_dc(latest)
        ratio = latest["dc_power_w"] / dc if dc > 0 else None
        efficiency = latest["ac_power_w"] / latest["dc_power_w"] if latest["dc_power_w"] > 0 else None
        recent = series[-3:]
        sufficiently_lit = all(r["irradiance_wm2"] >= 200 for r in recent)
        continuous = all((datetime.fromisoformat(b["timestamp"]) - datetime.fromisoformat(a["timestamp"])).total_seconds() <= 1800 for a, b in zip(recent, recent[1:]))
        fresh = (latest_global - datetime.fromisoformat(latest["timestamp"])).total_seconds() <= 1800
        sustained_power = len(recent) >= 3 and sufficiently_lit and all(r["dc_power_w"] < expected_dc(r) * 0.78 for r in recent)
        sustained_conversion = len(recent) >= 3 and sufficiently_lit and all(r["dc_power_w"] > 20 and r["ac_power_w"] / r["dc_power_w"] < 0.87 for r in recent)
        code, status, reason = "healthy", "healthy", "最近三个采样点在演示规则的正常区间内。"
        if not fresh:
            code, status, reason = "stale", "observe", "相对本批次最新记录落后超过 30 分钟，暂不下结论。"
        elif len(recent) < 3:
            code, status, reason = "insufficient", "observe", "连续样本不足 3 个，请补充数据。"
        elif not continuous:
            code, status, reason = "discontinuous", "observe", "最近三个采样点间隔超过 30 分钟，不能判定为连续异常。"
        elif not sufficiently_lit:
            code, status, reason = "low_light", "observe", "最近样本存在低于 200 W/m² 的辐照，暂不判断发电性能。"
        elif sustained_conversion:
            code, status, reason = "conversion_loss", "alert", "连续 3 个采样点交流/直流功率比低于 87%，需要核对测点和转换侧状态。"
        elif sustained_power:
            code, status, reason = "low_output", "alert", "连续 3 个采样点归一化直流功率低于 78%，需现场区分遮挡、积灰与测量问题。"
        elif ratio is not None and (ratio < 0.78 or (efficiency is not None and efficiency < 0.87)):
            code, status, reason = "transient", "observe", "出现单次或不连续偏差，先补充连续观测。"
        item = {**latest, "expected_dc_w": round(dc, 2), "normalized_ratio": round(ratio, 4) if ratio is not None else None, "conversion_ratio": round(efficiency, 4) if efficiency is not None else None, "status": status, "code": code, "reason": reason, "samples": len(series)}
        devices.append(item)
        if status != "healthy":
            findings.append({"device_id": device, "code": code, "status": status, "reason": reason, "evidence": recent, "metrics": {"normalized_ratio": item["normalized_ratio"], "conversion_ratio": item["conversion_ratio"], "expected_dc_w": item["expected_dc_w"]}})
    series = []
    for stamp in sorted({r["timestamp"] for r in rows}):
        same_time = [r for r in rows if r["timestamp"] == stamp]
        series.append({"timestamp": stamp, "actual_w": round(sum(r["ac_power_w"] for r in same_time), 2), "reference_w": round(sum(expected_dc(r) * 0.96 for r in same_time), 2)})
    return {"devices": devices, "findings": findings, "series": series, "counts": {"total": len(devices), "alert": sum(d["status"] == "alert" for d in devices), "observe": sum(d["status"] == "observe" for d in devices), "healthy": sum(d["status"] == "healthy" for d in devices)}, "actual_w": round(sum(d["ac_power_w"] for d in devices), 2), "reference_w": round(sum(d["expected_dc_w"] * 0.96 for d in devices), 2), "fingerprint": fingerprint(rows), "sample_count": len(rows), "latest": max(r["timestamp"] for r in rows)}


def recovery_demo(device, after, rated=500):
    start = datetime.fromisoformat(after) + timedelta(minutes=15)
    rows = []
    for i in range(3):
        r = {"timestamp": (start + timedelta(minutes=15 * i)).isoformat(), "device_id": device, "irradiance_wm2": 710.0, "module_temp_c": 44.0, "rated_power_w": rated}
        r["dc_power_w"] = round(expected_dc(r) * 0.99, 2)
        r["ac_power_w"] = round(r["dc_power_w"] * 0.96, 2)
        rows.append(r)
    return rows
