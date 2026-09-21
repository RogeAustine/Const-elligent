"""Dependency-free localhost web application. Run: python app.py"""
import argparse
import json
import secrets
import socket
import threading
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent import Agent, KNOWLEDGE, report
from model_client import configuration
from store import Store, now
from telemetry import SCENARIOS, as_csv, demo_rows, parse_csv, summarize

ROOT = Path(__file__).resolve().parent


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        # Windows otherwise permits two preview instances to share a port.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Application:
    def __init__(self, db_path):
        self.store = Store(db_path)
        self.agent = Agent(self.store)
        self.token = secrets.token_urlsafe(32)
        self.slots = threading.BoundedSemaphore(3)
        for name, metadata in SCENARIOS.items():
            self.store.save_dataset({"id": name, **metadata, "source": "demo", "created_at": now(), "rows": demo_rows(name)})

    def start(self, dataset_id, task):
        if not self.slots.acquire(blocking=False):
            raise ValueError("已有 3 个检查正在执行，请稍后重试。")
        try:
            run = self.agent.create_run(self.store.dataset(dataset_id), task)
        except Exception:
            self.slots.release()
            raise

        def worker():
            try:
                self.agent.execute(run["id"])
            finally:
                self.slots.release()
        threading.Thread(target=worker, daemon=True).start()
        return run


def make_server(port=8765, db_path=None):
    app = None

    class Handler(BaseHTTPRequestHandler):
        server_version = "JianZhi/1.0"

        def log_message(self, format, *args):
            # Do not log task content, CSV values, API keys or query strings.
            pass

        def reply(self, data, status=200, content_type="application/json; charset=utf-8", filename=None, style_nonce=None):
            if isinstance(data, (dict, list)):
                data = json.dumps(data, ensure_ascii=False).encode("utf-8")
            elif isinstance(data, str):
                data = data.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            style_policy = "style-src 'self'" + (f" 'nonce-{style_nonce}'" if style_nonce else "")
            self.send_header("Content-Security-Policy", f"default-src 'self'; script-src 'self'; {style_policy}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def host_ok(self):
            port_number = self.server.server_port
            return self.headers.get("Host") in (f"127.0.0.1:{port_number}", f"localhost:{port_number}")

        def do_GET(self):
            if not self.host_ok():
                return self.reply({"error": "请通过本机地址访问。"}, 403)
            parsed = urllib.parse.urlparse(self.path)
            path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
            try:
                if path == "/api/bootstrap":
                    return self.reply({"token": app.token, "datasets": app.store.datasets(), "model": configuration(), "knowledge": KNOWLEDGE, "runs": [{k: r.get(k) for k in ("id", "created_at", "status", "task", "dataset_name", "dataset_id", "source", "summary")} for r in app.store.runs()], "orders": app.store.orders()})
                if path == "/api/dataset":
                    dataset = app.store.dataset(query.get("id", ["mixed"])[0])
                    return self.reply({**{k: v for k, v in dataset.items() if k != "rows"}, "analysis": summarize(dataset["rows"])})
                if path == "/api/sample.csv":
                    return self.reply("\ufeff" + as_csv(demo_rows("mixed")), content_type="text/csv; charset=utf-8", filename="bipv-demo.csv")
                if path.startswith("/api/runs/"):
                    run = app.store.run(path.removeprefix("/api/runs/"))
                    if query.get("format") == ["md"]:
                        return self.reply(report(run), content_type="text/markdown; charset=utf-8", filename=run["id"] + ".md")
                    return self.reply(run)
                if path == "/api/orders":
                    return self.reply(app.store.orders())
                if path == "/architecture":
                    nonce = secrets.token_hex(16)
                    html = (ROOT / "docs" / "architecture.html").read_text(encoding="utf-8").replace("<style>", f'<style nonce="{nonce}">')
                    return self.reply(html, content_type="text/html; charset=utf-8", style_nonce=nonce)
                if path.startswith("/api/orders/"):
                    order = next((o for o in app.store.orders() if o["id"] == path.removeprefix("/api/orders/")), None)
                    if order is None:
                        raise ValueError("工单不存在。")
                    return self.reply(order, filename=order["id"] + ".json")
                static = {"/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/icon.svg": "icon.svg"}
                if path in static:
                    file = ROOT / "web" / static[path]
                    content_type = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}[file.suffix]
                    return self.reply(file.read_bytes(), content_type=content_type + "; charset=utf-8")
                return self.reply({"error": "页面或接口不存在。"}, 404)
            except ValueError as error:
                self.reply({"error": str(error)}, 400)

        def do_POST(self):
            origin = self.headers.get("Origin")
            valid_origins = (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}")
            if not self.host_ok() or (origin and origin not in valid_origins) or not secrets.compare_digest(self.headers.get("X-Agent-Token", ""), app.token):
                return self.reply({"error": "请求校验失败，请刷新本地页面。"}, 403)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2_200_000:
                    raise ValueError("请求为空或超过 2 MB。")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("接口要求 JSON 请求。")
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(body, dict):
                    raise ValueError("请求格式错误。")
                if self.path == "/api/analyze":
                    return self.reply(app.start(body.get("dataset_id", "mixed"), body.get("task", "")), 202)
                if self.path == "/api/import":
                    csv_text = body.get("csv")
                    if not isinstance(csv_text, str):
                        raise ValueError("请上传 UTF-8 编码的 CSV 文件。")
                    rows = parse_csv(csv_text)
                    label = body.get("name", "导入数据")
                    if not isinstance(label, str) or len(label) > 100:
                        raise ValueError("文件名过长。")
                    dataset = {"id": "CSV-" + uuid.uuid4().hex[:10], "label": label, "description": f"用户导入 · {len(rows)} 条记录", "source": "csv", "created_at": now(), "rows": rows}
                    app.store.save_dataset(dataset)
                    return self.reply({"id": dataset["id"], "records": len(rows)}, 201)
                if self.path == "/api/approve":
                    return self.reply(app.store.approve(body.get("run_id"), body.get("proposal_id"), body.get("approver", "")))
                if self.path == "/api/retest":
                    csv_text = body.get("csv")
                    if csv_text is not None and not isinstance(csv_text, str):
                        raise ValueError("复测 CSV 格式错误。")
                    return self.reply(app.agent.retest(body.get("order_id"), parse_csv(csv_text) if csv_text is not None else None, demo=body.get("demo") is True))
                return self.reply({"error": "接口不存在。"}, 404)
            except (ValueError, TypeError, KeyError) as error:
                return self.reply({"error": str(error) if isinstance(error, ValueError) else "请求字段格式不正确。"}, 400)
            except Exception:
                import traceback
                traceback.print_exc()
                return self.reply({"error": "本地服务处理失败，请检查终端日志。"}, 500)

    server = LocalServer(("127.0.0.1", port), Handler)
    try:
        app = Application(db_path or ROOT / "runtime" / "agent.sqlite3")
    except Exception:
        server.server_close()
        raise
    server.app = app
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="见仁建智 · BIPV 绿能运维智能体")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        server = make_server(args.port)
    except OSError as error:
        raise SystemExit(f"Cannot start server: {error}. Try: python app.py --port 8766")
    print(f"JianZhi Agent running at http://127.0.0.1:{server.server_port}", flush=True)
    print("Local demo. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
