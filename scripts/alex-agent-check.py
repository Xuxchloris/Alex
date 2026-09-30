"""Read-only, secret-free readiness probe using the installed Hermes runtime."""

import importlib.util
import json
import os
from pathlib import Path


def check():
    home = Path(os.environ["HERMES_HOME"])
    checks = []
    def add(name, status, detail):
        checks.append({"name": name, "status": status, "detail": detail})
    plugin = home / "plugins/alex/__init__.py"
    try:
        spec = importlib.util.spec_from_file_location("alex_readiness_probe", plugin, submodule_search_locations=[str(plugin.parent)])
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        # Check actual authentication, not just the token file's existence.
        module.AlexClient().request("GET", "/api/profile")
        add("business_auth", "ok", "Business API accepted the profile's configured credential; no customer data is displayed.")
    except Exception:
        add("business_auth", "error", "Business API authentication failed. Start the service and run alex connect --token-file <actual path>.")
    try:
        import yaml
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
        model = config.get("model")
        configured = bool(model.get("default")) if isinstance(model, dict) else bool(model)
        add("model", "warning", "Model selection exists; credentials, network and inference are unverified." if configured
            else "No model selection found. Run npm run alex -- model in this profile.")
    except Exception:
        add("model", "error", "Cannot parse the profile config. Run npm run alex -- setup.")
    add("gmail", "warning", "Gmail OAuth file exists; account access and scopes are unverified." if (home / "google_token.json").is_file()
        else "Gmail is not configured in this profile. Follow docs/alex-channels.md.")
    try:
        from gateway.status import is_gateway_runtime_lock_active
        running = is_gateway_runtime_lock_active()
        add("gateway", "ok" if running else "warning", "Gateway holds its runtime lock." if running else "No running gateway detected. Background work needs npm run alex -- gateway run.")
    except Exception:
        add("gateway", "warning", "Gateway status unavailable in this Hermes version; run alex cron status.")
    return {"ok": all(item["status"] != "error" for item in checks), "checks": checks, "liveModelCalls": 0, "mailboxCalls": 0}


if __name__ == "__main__":
    result = check()
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["ok"] else 1)
