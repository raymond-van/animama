"""Catch artifact boundaries that silently resolve back to source checkouts."""

import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("packed", Path(__file__).with_name("check-packed-artifacts.py"))
packed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packed)


class PackedArtifactTests(unittest.TestCase):
    """Real npm tarballs exercise manifest, emitted export and path validation."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "package.tgz"
        self.metadata = {
            "name": "@animama/runtime-contracts",
            "version": "0.1.0",
            "exports": {".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"}},
        }
        self.files = {
            "dist/index.js": "export const answer = 42;",
            "dist/index.d.ts": "export declare const answer: 42;",
            "dist/LICENSE": "GNU AFFERO GENERAL PUBLIC LICENSE",
            "dist/THIRD_PARTY_NOTICES.md": "MIT License\n\nCopyright (c) Hey API",
        }

    def pack(self):
        """Write the same package envelope emitted by npm/pnpm pack."""
        with tarfile.open(self.path, "w:gz") as archive:
            for name, content in {"package.json": json.dumps(self.metadata), **self.files}.items():
                data = content.encode()
                member = tarfile.TarInfo("package/" + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def test_emitted_package_passes(self):
        self.pack()
        self.assertEqual(packed.inspect_tarball(self.path)["name"], self.metadata["name"])

    def test_workspace_dependency_cannot_masquerade_as_portable_package(self):
        self.metadata["dependencies"] = {"@animama/product-ui": "workspace:*"}
        self.pack()
        with self.assertRaisesRegex(ValueError, "Source dependency"):
            packed.inspect_tarball(self.path)

    def test_private_web_alias_in_declarations_is_rejected(self):
        self.files["dist/index.d.ts"] = 'export type { Owner } from "@/app/local-runtime";'
        self.pack()
        with self.assertRaisesRegex(ValueError, "Checkout-bound import"):
            packed.inspect_tarball(self.path)

    def test_missing_licence_is_rejected(self):
        del self.files["dist/LICENSE"]
        self.pack()
        with self.assertRaisesRegex(ValueError, "Missing licence"):
            packed.inspect_tarball(self.path)

    def test_third_party_code_needs_its_notice(self):
        del self.files["dist/THIRD_PARTY_NOTICES.md"]
        self.pack()
        with self.assertRaisesRegex(ValueError, "Missing third-party notice"):
            packed.inspect_tarball(self.path)
        self.files["dist/THIRD_PARTY_NOTICES.md"] = "MIT License"
        self.pack()
        with self.assertRaisesRegex(ValueError, "Missing third-party notice"):
            packed.inspect_tarball(self.path)

    def test_product_ui_needs_its_adapted_code_notice(self):
        self.metadata["name"] = "@animama/product-ui"
        self.metadata["exports"]["./styles.css"] = "./dist/styles.css"
        self.files["dist/styles.css"] = ":root {}"
        self.pack()
        with self.assertRaisesRegex(ValueError, "Missing third-party notice"):
            packed.inspect_tarball(self.path)
        self.files["dist/THIRD_PARTY_NOTICES.md"] = "MIT License\n\nCopyright (c) 2023 shadcn"
        self.pack()
        self.assertEqual(packed.inspect_tarball(self.path)["name"], "@animama/product-ui")

    def test_missing_emitted_export_is_rejected(self):
        del self.files["dist/index.js"]
        self.pack()
        with self.assertRaisesRegex(ValueError, "emitted artifact bytes"):
            packed.inspect_tarball(self.path)

    def test_unsafe_archive_member_is_rejected(self):
        self.files["../outside.js"] = "export {};"
        self.pack()
        with self.assertRaisesRegex(ValueError, "Unsafe package member"):
            packed.inspect_tarball(self.path)

    def test_resolution_receipt_binds_retained_graph_and_inventory_bytes(self):
        work = Path(self.temp.name)
        graph = work / "pnpm-lock.yaml"
        graph.write_text("lockfileVersion: '9.0'\n")
        inventory = work / "backend-dependencies.json"
        inventory.write_text('[{"name":"example","version":"1.2.3"}]\n')
        receipt = packed.dependency_receipt([graph, inventory], work)
        self.assertEqual(receipt["mode"], "fresh-resolution")
        self.assertFalse(receipt["source_lockfiles_used"])
        self.assertEqual(receipt["evidence"][0]["path"], "pnpm-lock.yaml")
        original = receipt["evidence"][1]["sha256"]
        inventory.write_text('[{"name":"example","version":"1.2.4"}]\n')
        self.assertNotEqual(packed.dependency_receipt([inventory], work)["evidence"][0]["sha256"], original)
        inventory.unlink()
        with self.assertRaises(FileNotFoundError):
            packed.dependency_receipt([inventory], work)

    def test_each_step_records_its_wall_time_even_when_it_fails(self):
        logs = Path(self.temp.name)
        packed.PHASES.clear()
        self.addCleanup(packed.PHASES.clear)
        packed.run([sys.executable, "-c", "pass"], cwd=logs, logs=logs, name="quick", env={})
        with self.assertRaisesRegex(RuntimeError, r"broken failed \(3\) after [0-9.]+ s"):
            packed.run([sys.executable, "-c", "raise SystemExit(3)"], cwd=logs, logs=logs, name="broken", env={})
        self.assertEqual([phase["name"] for phase in packed.PHASES], ["quick", "broken"])
        self.assertTrue(all(phase["seconds"] >= 0 for phase in packed.PHASES))


class ConsumerPackageTests(unittest.TestCase):
    """The fixture's own dependency holds survive the tarball overrides."""

    tarballs = {name: f"file:artifacts/{name.split('/')[1]}-1.0.0.tgz" for name in packed.PACKAGES}

    def test_fixture_overrides_are_kept_beside_tarball_overrides(self):
        fixture = {"dependencies": {"react": "19.2.5"}, "pnpm": {"overrides": {"csstype": "3.2.3"}}}
        package = packed.consumer_package(fixture, self.tarballs)
        self.assertEqual(package["pnpm"]["overrides"], {"csstype": "3.2.3", **self.tarballs})
        self.assertEqual(package["dependencies"], {"react": "19.2.5", **self.tarballs})
        # The caller's fixture is left as read.
        self.assertEqual(fixture["pnpm"]["overrides"], {"csstype": "3.2.3"})

    def test_fixture_without_overrides_gets_only_the_tarballs(self):
        package = packed.consumer_package({"dependencies": {}}, self.tarballs)
        self.assertEqual(package["pnpm"], {"overrides": self.tarballs})

    def test_fixture_cannot_redirect_a_packed_package(self):
        keys = (
            "@animama/product-ui",
            "@animama/product-ui@<1",
            "@animama/product-ui@>=0.1.0",
            "react>@animama/runtime-contracts@*",
            "@animama/discover-client@1>csstype",
        )
        for key in keys:
            with self.subTest(key=key):
                fixture = {"dependencies": {}, "pnpm": {"overrides": {key: "0.1.0"}}}
                with self.assertRaisesRegex(ValueError, "cannot name packed packages"):
                    packed.consumer_package(fixture, self.tarballs)

    def test_fixture_resolutions_are_refused(self):
        # pnpm reads `resolutions` as overrides too, outside the guard above.
        fixture = {"dependencies": {}, "resolutions": {"csstype": "3.2.3"}}
        with self.assertRaisesRegex(ValueError, "not resolutions"):
            packed.consumer_package(fixture, self.tarballs)

    def test_only_overrides_carry_over_from_the_fixture(self):
        fixture = {"dependencies": {}, "pnpm": {"packageExtensions": {"@animama/product-ui": {"dependencies": {}}}}}
        self.assertEqual(packed.consumer_package(fixture, self.tarballs)["pnpm"], {"overrides": self.tarballs})

    def test_checked_in_frontend_fixture_composes(self):
        fixture = json.loads((packed.FIXTURES / "frontend/package.json").read_text())
        package = packed.consumer_package(fixture, self.tarballs)
        self.assertLessEqual(fixture.get("pnpm", {}).get("overrides", {}).items(), package["pnpm"]["overrides"].items())


class WheelTests(unittest.TestCase):
    """The wheel must carry the AGPL and the upstream texts of its adapted code."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "animama_backend-0.3.0-py3-none-any.whl"
        dist_info = "animama_backend-0.3.0.dist-info/licenses/"
        self.files = {"animama/domain/usage.py": b"class Usage: ...\n"}
        # The real repository texts, placed where hatchling puts license-files.
        for licence in packed.WHEEL_LICENSES:
            self.files[dist_info + licence] = (packed.ROOT / licence).read_bytes()

    def build(self):
        with zipfile.ZipFile(self.path, "w") as archive:
            for name, data in self.files.items():
                archive.writestr(name, data)

    def test_wheel_with_its_licence_texts_passes(self):
        self.build()
        self.assertEqual(packed.inspect_wheel(self.path)["name"], self.path.name)

    def test_each_missing_or_empty_licence_text_is_rejected(self):
        for licence in packed.WHEEL_LICENSES:
            name = next(name for name in self.files if name.endswith("/licenses/" + licence))
            with self.subTest(licence=licence):
                original = self.files.pop(name)
                self.build()
                with self.assertRaisesRegex(ValueError, "missing licence text"):
                    packed.inspect_wheel(self.path)
                self.files[name] = b""
                self.build()
                with self.assertRaisesRegex(ValueError, "missing licence text"):
                    packed.inspect_wheel(self.path)
                self.files[name] = original

    def test_editable_redirect_is_rejected(self):
        self.files["__editable__.animama_backend-0.3.0.pth"] = b"/checkout/src/backend\n"
        self.build()
        with self.assertRaisesRegex(ValueError, "Editable import redirects"):
            packed.inspect_wheel(self.path)


if __name__ == "__main__":
    unittest.main()
