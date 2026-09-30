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
        print(json.dumps({"nativeLoader": True, "toolCount": len(manifest.provides_tools),
                          "skill": "alex:trade-research", "desktopSurface": True, "unloadCleanup": True}))


if __name__ == "__main__":
    main()
