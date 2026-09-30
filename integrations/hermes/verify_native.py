"""Optional verification using the installed official Hermes loader, without mocks.

Run with Hermes v2026.9.24 on PYTHONPATH or in its Python environment.
It uses a temporary Hermes home, never the user's actual plugin/config directory.
"""


def main():
    import json
    import os
    from pathlib import Path
    import tempfile

    with tempfile.TemporaryDirectory(prefix="alex-hermes-native-") as home:
        os.environ["HERMES_HOME"] = home
        from hermes_cli.plugins import PluginManager, parse_manifest_file
        from hermes_cli.plugin_validate_desktop import desktop_surface_hits
        from tools.registry import registry

        plugin_dir = Path(__file__).parent.resolve()
        manifest = parse_manifest_file(plugin_dir / "plugin.yaml", plugin_dir, "user", "")
        assert manifest and manifest.name == "alex", "Native plugin manifest rejected"
        manager = PluginManager()
        manager._load_plugin(manifest)
        inventory = manager.list_plugins()
        assert len(inventory) == 1 and inventory[0]["enabled"] and not inventory[0]["error"], inventory
        assert inventory[0]["tools"] == len(manifest.provides_tools), inventory
        for name in manifest.provides_tools:
            entry = registry.get_entry(name, scope=manager.scope_key)
            assert entry and entry.schema["name"] == name, name
        assert manager.find_plugin_skill("alex:trade-research").is_file()
        assert not desktop_surface_hits(plugin_dir), "Desktop plugin exceeds official SDK surface"
        manager.unload("alex")
        assert all(registry.get_entry(name, scope=manager.scope_key) is None for name in manifest.provides_tools)
        assert manager.find_plugin_skill("alex:trade-research") is None
        import importlib.util
        routine_path = plugin_dir.parent.parent / "scripts" / "alex-routine.py"
        spec = importlib.util.spec_from_file_location("alex_routine_verification", routine_path)
        routine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(routine)
        created = routine.install(1)
        again = routine.install(2)
        assert created["created"] and not created["enabled"] and created["state"] == "paused", created
        assert not again["created"] and again["jobId"] == created["jobId"], again
        from cron.jobs import get_job
        job = get_job(created["jobId"])
        assert job["deliver"] == "local" and job["skills"] == ["alex-daily-review"]
        assert job["enabled_toolsets"] == ["alex", "skills", "memory", "session_search", "todo"]
        assert job["script"] is None and job["last_run_at"] is None
        print(json.dumps({"nativeLoader": True, "toolCount": len(manifest.provides_tools),
                          "skill": "alex:trade-research", "desktopSurface": True, "unloadCleanup": True,
                          "nativeRoutineStore": True, "routineCreatedPaused": True, "routineIdempotent": True}))


if __name__ == "__main__":
    main()
