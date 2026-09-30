"""Run actual Hermes AIAgent turns with scripted model decisions and live Alex tools.

Internal helper for alex-record-agent-demo.mjs. No real model credential is used.
Only loopback connections are permitted; HERMES_HOME/HOME must be isolated.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch


FACTS = {"product": "精密加工刀具（演示资料）", "market": "德国", "customerType": "工业分销商"}
DRAFT = {"channel": "gmail", "recipient": "fixture@example.test", "subject": "Fixture only — never send",
         "body": "Controlled integration fixture. This is not customer outreach.", "idempotencyKey": "alex-agent-demo-draft-v1"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--phase", choices=("initial", "restart"), required=True)
    args = parser.parse_args()
    profile = Path(os.environ["HERMES_HOME"]).resolve()
    assert profile.is_dir() and profile.name == "hermes", "Use the isolated recorder wrapper"
    assert not (profile / "alex-outreach-policy.json").exists(), "Demo must never authorize sending"

    def prohibit_external_connections(event, values):
        if event != "socket.connect":
            return
        address = values[1]
        if not isinstance(address, tuple):
            raise PermissionError("Agent demo permits loopback TCP only")
        try:
            allowed = ipaddress.ip_address(address[0]).is_loopback
        except ValueError:
            allowed = address[0] == "localhost"
        if not allowed:
            raise PermissionError("Agent demo refuses all external network connections")

    sys.addaudithook(prohibit_external_connections)
    # Imports happen after the wrapper selects a clean HOME and HERMES_HOME.
    import hermes_cli.plugins as plugins
    from tools.registry import registry
    from run_agent import AIAgent

    manager = plugins.PluginManager()
    parse_manifest = getattr(plugins, "parse_manifest_file", None) or manager._parse_manifest
    manifest = parse_manifest(args.plugin / "plugin.yaml", args.plugin, "user", "")
    assert manifest and manifest.name == "alex"
    manager._load_plugin(manifest)
    inventory = manager.list_plugins()
    assert len(inventory) == 1 and inventory[0]["enabled"] and not inventory[0]["error"], inventory
    scope = getattr(manager, "scope_key", None)
    for tool in ("alex_profile_get", "alex_profile_update", "alex_outreach_prepare", "alex_outreach_send"):
        entry = registry.get_entry(tool, **({"scope": scope} if scope is not None else {}))
        assert entry, f"Actual Hermes loader did not register {tool}"

    events = []
    last_delivery = None

    def completed(call_id, name, params, result):
        nonlocal last_delivery
        value = json.loads(result) if isinstance(result, str) else result
        if name == "alex_outreach_prepare":
            assert value["ok"] is True, value
            last_delivery = value["result"]["id"]
        events.append({"at": datetime.now(timezone.utc).isoformat(), "phase": args.phase,
                       "tool": name, "arguments": params, "result": value})

    steps = ([("alex_profile_get", {}), ("alex_profile_update", {"facts": FACTS}),
              ("alex_customers_list", {"includeArchived": True}), ("alex_tasks_list", {}),
              ("alex_outreach_prepare", DRAFT), ("alex_outreach_send", None)] if args.phase == "initial" else
             [("alex_profile_get", {}), ("alex_outreach_prepare", DRAFT),
              ("alex_outreach_status", {}), ("alex_outreach_list", {})])

    class ScriptedCompletions:
        """OpenAI-compatible shape; decisions are fixtures, not AI inference."""
        def __init__(self):
            self.calls = 0

        def create(self, **kwargs):
            index = self.calls
            self.calls += 1
            assert self.calls <= len(steps) + 1, "Unexpected extra model request"
            if index < len(steps):
                name, params = steps[index]
                if params is None:
                    assert last_delivery, "Prepare must complete before send is tested"
                    params = {"deliveryId": last_delivery}
                message = SimpleNamespace(content=None, reasoning=None, tool_calls=[SimpleNamespace(
                    id=f"fixture_{args.phase}_{index}", type="function",
                    function=SimpleNamespace(name=name, arguments=json.dumps(params, ensure_ascii=False)))])
                finish = "tool_calls"
            else:
                message = SimpleNamespace(content="Fixture complete. No real model or external outreach was used.",
                                          reasoning=None, tool_calls=[])
                finish = "stop"
            return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish)], usage=None)

    fixture = ScriptedCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=fixture), close=lambda: None)
    agent = None
    try:
        # Mirrors Hermes' official tests' client injection. Tool definitions,
        # dispatcher, plugin handlers, HTTP API and SQLite stores remain real.
        with patch("run_agent.OpenAI", return_value=client):
            agent = AIAgent(model="alex-scripted-fixture", api_key="fixture-not-a-real-key",
                            base_url="http://127.0.0.1:9/v1", platform="cli", enabled_toolsets=["alex"],
                            max_iterations=len(steps) + 3, quiet_mode=True, skip_memory=True,
                            skip_context_files=True, tool_delay=0, tool_complete_callback=completed)
            agent._disable_streaming = True
            requested = {name for name, _ in steps}
            assert requested <= agent.valid_tool_names, f"Missing tools: {requested - agent.valid_tool_names}"
            result = agent.run_conversation(
                "受控集成验收。用户明确演示资料：精密加工刀具，德国，工业分销商。"
                "仅检查实际工具和持久状态；fixture@example.test 是测试地址，禁止真实外发。",
                system_message="Controlled fixture. No real leads, connected accounts or model inference.")
        assert result["final_response"].startswith("Fixture complete"), result.get("final_response")
        assert [event["tool"] for event in events] == [name for name, _ in steps]
        if args.phase == "initial":
            assert events[0]["result"]["result"]["facts"] == {}
            assert events[2]["result"]["result"] == [] and events[3]["result"]["result"] == []
            assert events[-1]["result"]["ok"] is False
            assert events[-1]["result"]["code"] == "outreach_not_authorized"
        else:
            assert events[0]["result"]["result"]["facts"] == FACTS
            assert events[2]["result"]["result"]["attempts_today"] == 0
            assert events[2]["result"]["result"]["policy"]["enabled"] is False
            assert len(events[3]["result"]["result"]) == 1
        hermes_root = Path(plugins.__file__).resolve().parent.parent
        version = subprocess.run(["git", "-C", str(hermes_root), "rev-parse", "HEAD"],
                                 capture_output=True, text=True, check=False).stdout.strip() or "unknown"
        args.trace.write_text(json.dumps({"hermesCommit": version, "nativeLoader": True,
            "actualAIAgentLoop": True, "registeredToolCount": inventory[0]["tools"],
            "modelMode": "scripted-openai-compatible-client-fixture", "realModelCalls": 0,
            "fixtureCompletionCalls": fixture.calls, "events": events}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print(json.dumps({"phase": args.phase, "toolCalls": len(events), "actualAIAgentLoop": True}))
    finally:
        if agent:
            agent.close()
        # Older installed Hermes versions have no public unload API. The
        # isolated helper process exits immediately, releasing its registry.
        if hasattr(manager, "unload"):
            manager.unload("alex")


if __name__ == "__main__":
    main()
