import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from agent import Agent, report
from app import make_server
from store import Store
from telemetry import as_csv, demo_rows, parse_csv, recovery_demo, summarize


class TelemetryTests(unittest.TestCase):
    def test_mixed_detects_two_distinct_issues(self):
        result = summarize(demo_rows())
        self.assertEqual(result["counts"], {"total": 8, "alert": 2, "observe": 0, "healthy": 6})
        self.assertEqual({f["device_id"]: f["code"] for f in result["findings"]}, {"PV-03": "low_output", "PV-06": "conversion_loss"})

    def test_cloud_is_not_equipment_failure(self):
        result = summarize(demo_rows("cloud"))
        self.assertEqual(result["counts"]["alert"], 0)
        self.assertLess(result["series"][-1]["actual_w"], result["series"][0]["actual_w"] * 0.6)

    def test_low_light_is_observation_not_healthy(self):
        result = summarize(demo_rows("lowlight"))
        self.assertEqual(result["counts"]["observe"], 8)
        self.assertEqual(result["counts"]["alert"], 0)

    def test_round_trip_csv(self):
        rows = demo_rows()
        self.assertEqual(parse_csv(as_csv(rows)), sorted(rows, key=lambda r: (r["timestamp"], r["device_id"])))

    def test_rejects_nan_infinite_negative_and_wrong_units(self):
        for value in ["nan", "inf", -1, 1e15]:
            with self.subTest(value=value):
                rows = demo_rows()
                rows[0]["dc_power_w"] = value
                with self.assertRaises(ValueError):
                    parse_csv(as_csv(rows))

    def test_rejects_duplicates_missing_columns_and_empty(self):
        rows = demo_rows()
        for content in [as_csv(rows + [rows[0]]), "timestamp,device_id\n2026-01-01,PV-01", as_csv([])]:
            with self.subTest(content=content[:20]), self.assertRaises(ValueError):
                parse_csv(content)

    def test_rejects_mismatched_ac_dc(self):
        rows = demo_rows()
        rows[0]["ac_power_w"] = 900
        with self.assertRaises(ValueError):
            parse_csv(as_csv(rows))

    def test_rejects_changed_nameplate(self):
        rows = demo_rows()
        rows[0]["rated_power_w"] = 400
        with self.assertRaises(ValueError):
            parse_csv(as_csv(rows))

    def test_short_series_does_not_create_alert(self):
        result = summarize(demo_rows()[-16:])
        self.assertEqual(result["counts"]["observe"], 8)

    def test_gaps_do_not_count_as_continuous_samples(self):
        rows = [r for r in demo_rows() if r["device_id"] == "PV-03"][-3:]
        rows[0]["timestamp"] = "2026-09-18T10:00:00"
        result = summarize(rows)
        self.assertEqual(result["devices"][0]["code"], "discontinuous")

    def test_single_deviation_is_observation(self):
        rows = demo_rows("normal")
        rows[-1]["dc_power_w"] *= 0.4
        rows[-1]["ac_power_w"] *= 0.4
        result = summarize(rows)
        self.assertEqual(result["counts"]["alert"], 0)
        self.assertEqual(result["counts"]["observe"], 1)

    def test_stale_device_is_observation(self):
        rows = [r for r in demo_rows() if r["device_id"] != "PV-03" or r["timestamp"] < "2026-09-20T10:00:00"]
        result = summarize(rows)
        self.assertEqual(next(d for d in result["devices"] if d["device_id"] == "PV-03")["code"], "stale")


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "test.db")
        self.agent = Agent(self.store)
        self.dataset = {"id":"test", "label":"测试集", "source":"demo", "rows":demo_rows()}
        self.store.save_dataset(self.dataset)
        self.model_patch = patch("model_client.configuration", return_value={"enabled": False})
        self.model_patch.start()

    def tearDown(self):
        self.model_patch.stop()
        self.temp.cleanup()

    def run_agent(self, task="检查全站并自动生成工单"):
        run = self.agent.create_run(self.dataset, task)
        self.agent.execute(run["id"])
        return self.store.run(run["id"])

    def approve(self):
        run = self.run_agent()
        return run, self.store.approve(run["id"], run["proposals"][0]["id"], "演示审核人")

    def test_proposals_and_real_tool_trace_without_automatic_approval(self):
        run = self.run_agent()
        self.assertEqual(run["status"], "done")
        self.assertEqual(len(run["trace"]), 5)
        self.assertEqual(len(run["proposals"]), 2)
        self.assertEqual(self.store.orders(), [])
        self.assertIn("KB-01", report(run))
        self.assertIn("PV-03", report(run))

    def test_device_scope(self):
        run = self.run_agent("只检查 pv-03")
        self.assertEqual(run["analysis"]["counts"]["total"], 1)
        self.assertEqual(len(run["proposals"]), 1)

    def test_unknown_device_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_agent("检查 PV-99")

    def test_approval_is_idempotent_and_requires_name(self):
        run = self.run_agent()
        proposal = run["proposals"][0]["id"]
        with self.assertRaises(ValueError):
            self.store.approve(run["id"], proposal, " ")
        first = self.store.approve(run["id"], proposal, "审核人")
        second = self.store.approve(run["id"], proposal, "审核人")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.orders()), 1)

    def test_cannot_approve_another_runs_proposal(self):
        first = self.run_agent()
        second = self.run_agent()
        with self.assertRaises(ValueError):
            self.store.approve(first["id"], second["proposals"][0]["id"], "审核人")

    def test_duplicate_active_order_is_rejected(self):
        self.approve()
        run = self.run_agent()
        with self.assertRaises(ValueError):
            self.store.approve(run["id"], run["proposals"][0]["id"], "审核人")

    def test_demo_recovery_closes_with_audit_evidence(self):
        _, order = self.approve()
        closed = self.agent.retest(order["id"], demo=True)
        self.assertEqual(closed["status"], "closed")
        self.assertEqual(len(closed["retests"][0]["rows"]), 3)
        self.assertEqual(closed["retests"][0]["source"], "demo")
        with self.assertRaises(ValueError):
            self.agent.retest(order["id"], demo=True)

    def test_failed_retest_keeps_order_open(self):
        _, order = self.approve()
        rows = recovery_demo(order["device_id"], order["last_anomaly_at"])
        for row in rows:
            row["dc_power_w"] *= 0.5
            row["ac_power_w"] *= 0.5
        result = self.agent.retest(order["id"], rows)
        self.assertEqual(result["status"], "open")
        self.assertFalse(result["retests"][0]["passed"])

    def test_old_retest_is_rejected(self):
        _, order = self.approve()
        with self.assertRaises(ValueError):
            self.agent.retest(order["id"], demo_rows())

    def test_real_import_cannot_be_closed_with_demo(self):
        self.dataset["source"] = "csv"
        self.store.save_dataset(self.dataset)
        _, order = self.approve()
        with self.assertRaises(ValueError):
            self.agent.retest(order["id"], demo=True)
        result = self.agent.retest(order["id"], recovery_demo(order["device_id"], order["last_anomaly_at"]))
        self.assertEqual(result["status"], "closed")
        self.assertEqual(result["retests"][0]["source"], "csv")

    def test_model_failure_does_not_discard_valid_local_results(self):
        with patch("model_client.configuration", return_value={"enabled":True}), patch("model_client.explain", side_effect=TimeoutError):
            run = self.run_agent()
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["model_status"], "unavailable")
        self.assertEqual(len(run["proposals"]), 2)

    def test_model_explanation_cannot_modify_approval_state(self):
        with patch("model_client.configuration", return_value={"enabled":True}), patch("model_client.explain", return_value="已自动确认所有工单"):
            run = self.run_agent()
        self.assertEqual(run["model_status"], "done")
        self.assertEqual(self.store.orders(), [])

    def test_restart_preserves_data_and_marks_interrupted_run(self):
        _, order = self.approve()
        pending = self.agent.create_run(self.dataset, "稍后检查")
        reopened = Store(self.store.path)
        self.assertEqual(reopened.orders()[0]["id"], order["id"])
        self.assertEqual(reopened.run(pending["id"])["status"], "failed")


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = make_server(0, Path(cls.temp.name) / "http.db")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, path, body=None, token=True, origin=None):
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
            if token:
                headers["X-Agent-Token"] = self.server.app.token
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.loads(response.read())

    def test_http_end_to_end(self):
        self.assertTrue(self.request("/api/bootstrap")["token"])
        run = self.request("/api/analyze", {"dataset_id":"mixed", "task":"检查全站"})
        for _ in range(40):
            result = self.request("/api/runs/" + run["id"])
            if result["status"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(result["status"], "done")
        order = self.request("/api/approve", {"run_id":run["id"], "proposal_id":result["proposals"][0]["id"], "approver":"接口测试"})
        retest = self.request("/api/retest", {"order_id":order["id"], "demo":True})
        self.assertEqual(retest["status"], "closed")
        with urllib.request.urlopen(self.url + "/api/runs/" + run["id"] + "?format=md") as response:
            self.assertIn("处置草案".encode(), response.read())

    def test_blocks_cross_origin_and_missing_token(self):
        for token, origin in [(False, None), (True, "https://external.example")]:
            with self.subTest(token=token, origin=origin), self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/analyze", {"task":"检查"}, token=token, origin=origin)
            self.assertEqual(error.exception.code, 403)

    def test_import_validation_returns_400(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/import", {"name":"invalid.csv", "csv":"bad"})
        self.assertEqual(error.exception.code, 400)

    def test_supplied_csv_examples_complete_import_retest_flow(self):
        folder = Path(__file__).resolve().parents[1] / "examples"
        imported = self.request("/api/import", {"name":"inspection.csv", "csv":(folder / "inspection.csv").read_text(encoding="utf-8")})
        run = self.request("/api/analyze", {"dataset_id":imported["id"], "task":"检查全站"})
        for _ in range(40):
            result = self.request("/api/runs/" + run["id"])
            if result["status"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(len(result["proposals"]), 1)
        order = self.request("/api/approve", {"run_id":run["id"], "proposal_id":result["proposals"][0]["id"], "approver":"样例测试"})
        with self.assertRaises(urllib.error.HTTPError) as blocked:
            self.request("/api/retest", {"order_id":order["id"], "demo":True})
        self.assertEqual(blocked.exception.code, 400)
        closed = self.request("/api/retest", {"order_id":order["id"], "csv":(folder / "retest.csv").read_text(encoding="utf-8")})
        self.assertEqual(closed["status"], "closed")

    def test_main_page_and_javascript_are_served_locally(self):
        for path, content_type in [("/", "text/html"), ("/app.js", "text/javascript"), ("/styles.css", "text/css")]:
            with self.subTest(path=path), urllib.request.urlopen(self.url + path) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.headers["Content-Type"].startswith(content_type))
                self.assertIn("script-src 'self'", response.headers["Content-Security-Policy"])

    def test_static_directory_cannot_expose_database(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/runtime/agent.sqlite3")
        self.assertEqual(error.exception.code, 404)

    def test_second_server_cannot_reuse_running_port(self):
        with self.assertRaises(OSError):
            make_server(self.server.server_port, Path(self.temp.name) / "other.db")

    def test_architecture_has_approved_styles_and_no_external_assets(self):
        with urllib.request.urlopen(self.url + "/architecture") as response:
            html = response.read().decode("utf-8")
            policy = response.headers["Content-Security-Policy"]
        self.assertIn('style nonce="', html)
        self.assertIn("'nonce-", policy)
        self.assertNotIn("https://", html)


if __name__ == "__main__":
    unittest.main()
