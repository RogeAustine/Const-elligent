"""One local SQLite database; transactional approval and persistent audit trails."""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, proposal_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            """)
        # A restarted process cannot resume its vanished background threads.
        for run in self.runs():
            if run["status"] == "running":
                run["status"] = "failed"
                run["error"] = "服务重启中断了该次检查，请重新发起。"
                self.save_run(run)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        try:
            db.execute("PRAGMA busy_timeout=15000")
            with db:
                yield db
        finally:
            db.close()

    def save_run(self, run):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO runs VALUES (?,?)", (run["id"], json.dumps(run, ensure_ascii=False)))

    def run(self, run_id):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise ValueError("检查记录不存在。")
        return json.loads(row[0])

    def runs(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 200").fetchall()
        return [json.loads(r[0]) for r in rows]

    def orders(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM orders ORDER BY rowid DESC").fetchall()
        return [json.loads(r[0]) for r in rows]

    def save_dataset(self, dataset):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO datasets VALUES (?,?)", (dataset["id"], json.dumps(dataset, ensure_ascii=False)))

    def dataset(self, dataset_id):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM datasets WHERE id=?", (dataset_id,)).fetchone()
        if not row:
            raise ValueError("数据集不存在，请重新选择或导入。")
        return json.loads(row[0])

    def datasets(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM datasets ORDER BY rowid DESC LIMIT 50").fetchall()
        return [{k: v for k, v in json.loads(r[0]).items() if k != "rows"} for r in rows]

    def approve(self, run_id, proposal_id, approver):
        if not isinstance(approver, str) or not 1 <= len(approver.strip()) <= 60:
            raise ValueError("请填写 1–60 字的确认人名称。")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
            run = json.loads(row[0]) if row else None
            if not run or run["status"] != "done":
                raise ValueError("检查未完成，不能确认草案。")
            proposal = next((p for p in run["proposals"] if p["id"] == proposal_id), None)
            if not proposal:
                raise ValueError("草案不存在或不属于本次检查。")
            previous = db.execute("SELECT payload FROM orders WHERE proposal_id=?", (proposal_id,)).fetchone()
            if previous:
                return json.loads(previous[0])
            for existing, in db.execute("SELECT payload FROM orders"):
                existing = json.loads(existing)
                if existing["device_id"] == proposal["device_id"] and existing["code"] == proposal["code"] and existing["status"] == "open" and existing["dataset_id"] == run["dataset_id"]:
                    raise ValueError("该设备同类异常已有待复测工单，请先处理现有工单。")
            order = {**proposal, "id": "WO-" + uuid.uuid4().hex[:8].upper(), "proposal_id": proposal_id, "run_id": run_id, "dataset_id": run["dataset_id"], "source": run["source"], "status": "open", "approver": approver.strip(), "approved_at": now(), "events": [{"at": now(), "event": "人工确认生成本地工单", "by": approver.strip()}], "retests": []}
            db.execute("INSERT INTO orders VALUES (?,?,?)", (order["id"], proposal_id, json.dumps(order, ensure_ascii=False)))
        return order

    def record_retest(self, order_id, result):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM orders WHERE id=?", (order_id,)).fetchone()
            if not row:
                raise ValueError("工单不存在。")
            order = json.loads(row[0])
            if order["status"] == "closed":
                raise ValueError("该工单已关闭，无需重复复测。")
            order["retests"].append(result)
            order["status"] = "closed" if result["passed"] else "open"
            order["events"].append({"at": now(), "event": "复测通过，关闭工单" if result["passed"] else "复测未通过，保持待处理", "source": result["source"], "fingerprint": result["fingerprint"]})
            db.execute("UPDATE orders SET payload=? WHERE id=?", (json.dumps(order, ensure_ascii=False), order_id))
        return order
