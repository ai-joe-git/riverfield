"""CPU-only parity checks against the real builder and installed native planner helpers.

AST extraction executes only named pure functions, never imports torch/ComfyUI or loads models.
"""
import ast
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("riverfield_h3", ROOT / "comfy-nodes/riverfield-comfy-nodes/nodes/h3_planner.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
NATIVE = Path(os.environ.get("RIVERFIELD_NATIVE_DIRECTOR", Path.home() / "comfyui-vanilla-gfx1151/ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-TimelineDirector"))


def native_functions():
    namespace = dict(copy=copy, json=json, math=math, Path=Path, FPS=24, H3_FPS=24, MAX_REF_IMAGES=9, MAX_REF_AUDIOS=3)
    wanted = {
        "minimax_h3_timeline_director.py": {"_float", "_audio_mode", "_locked_audio_assets", "_ordered_segment_assets", "_timeline_for_prompt_index", "_require_timeline_plan", "_reference_manifest"},
        "minimax_h3_finite_segments.py": {"_plan_for_segment", "_finite_plan_for_segment", "_prepare_timeline_segments", "_locked_audio_for_plan", "_finite_locked_audio_asset", "_video_soundtrack_lock_for_plan", "_finite_video_audio_muted"},
        "experimental_latent_guide.py": {"_valid_guide_frames"},
    }
    for filename, names in wanted.items():
        tree = ast.parse((NATIVE / filename).read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        assert {n.name for n in nodes} == names, f"Native contract changed in {filename}"
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)] + nodes, type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(NATIVE / filename), "exec"), namespace)
    return namespace


def plan(windows, mode="reference", global_prompt=""):
    timeline = json.loads(builder.build_timeline(generation_seconds=7.3, global_prompt=global_prompt, images=["alex.png", "room.png"], audios=["music.wav", "other.wav"], audio_mode=mode, segment_windows=json.dumps({"windows": windows})))
    return dict(type="MINIMAX_H3_TIMELINE_PLAN", timeline=timeline, width=480, height=832, length=175, generation_seconds=7.3, prompt_index=None, segment_count=len(windows))


def windows(count=2):
    return [dict(start=i * 136, end=i * 136 + 175, prompt=f"Prompt {i + 1}", images=[1, 0], audios=[0]) for i in range(count)]


class BuilderContractTest(unittest.TestCase):
    def test_native_geometry_and_explicit_local_order(self):
        timeline = plan(windows(5))["timeline"]
        self.assertEqual([(w["startFrame"], w["endFrame"]) for w in timeline["segmentConfig"]["segments"]], [(0, 175), (136, 311), (272, 447), (408, 583), (544, 719)])
        self.assertEqual(timeline["segmentConfig"]["segments"][0]["images"], ["rf-image-2", "rf-image-1"])
        self.assertFalse(timeline["secondPass"])

    def test_multiline_legacy_field_is_not_a_complete_prompt(self):
        text = "subject_definitions:\n<Subject 1> from Picture 1\nsummary:\nA scene"
        timeline = json.loads(builder.build_timeline(generation_seconds=7.3, segment_prompts=text))
        self.assertEqual(timeline["segmentConfig"]["segments"][0]["prompt"], "subject_definitions:")


@unittest.skipUnless((NATIVE / "minimax_h3_finite_segments.py").exists(), "Installed native Director not available; set RIVERFIELD_NATIVE_DIRECTOR")
class InstalledNativeContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = native_functions()

    def test_finite_sampler_consumes_builder_geometry_and_order(self):
        finite = self.native["_prepare_timeline_segments"](plan(windows(5)))
        self.assertEqual(finite["segment_lengths"], [175] * 5)
        self.assertEqual(finite["segment_overlaps"], [0, 39, 39, 39, 39])
        self.assertEqual(finite["target_output_frames"], 719)
        self.assertEqual([a["file"] for a in finite["segment_plans"][0]["timeline"]["images"]], ["room.png", "alex.png"])

    def test_global_fallback_is_all_or_nothing(self):
        rows = windows()
        for row in rows:
            row["prompt"] = ""
        self.assertEqual(self.native["_prepare_timeline_segments"](plan(rows, global_prompt="Full global prompt"))["prompts"], ["Full global prompt"] * 2)
        rows[0]["prompt"] = "Local prompt"
        with self.assertRaisesRegex(ValueError, "enter prompts for every segment"):
            self.native["_prepare_timeline_segments"](plan(rows, global_prompt="Global"))

    def test_locked_soundtrack_must_be_one_continuous_assignment(self):
        finite = self.native["_prepare_timeline_segments"](plan(windows(), mode="locked"))
        self.assertEqual(self.native["_finite_locked_audio_asset"](finite)["file"], "music.wav")
        for assignment, message in [([], "only some segments"), ([1], "same audio file"), ([0, 1], "at most one")]:
            rows = windows()
            rows[1]["audios"] = assignment
            with self.assertRaisesRegex(ValueError, message):
                self.native["_finite_locked_audio_asset"](self.native["_prepare_timeline_segments"](plan(rows, mode="locked")))

    def test_native_audio_manifest_uses_standalone_before_video_soundtrack(self):
        # Mock only the decoded-video planning result; execute the installed native label renderer.
        self.native["_video_reference_specs"] = lambda _: [dict(name="reference clip", source_start=0, duration=1, has_audio=True)]
        source = plan(windows())
        source["timeline"]["audios"] = source["timeline"]["audios"][:1]
        manifest = self.native["_reference_manifest"](source)
        self.assertIn("<Audio 1> = standalone audio music.wav", manifest)
        self.assertIn("<Audio 2> = original audio paired with <Video 1>", manifest)

    def test_video_audio_global_mute_is_not_the_per_clip_visual_only_switch(self):
        source = plan(windows())
        source["timeline"]["audios"] = []
        source["timeline"]["videoClips"] = [dict(file="source.mp4", start=0, duration=7.3, hasAudio=True)]
        finite = self.native["_prepare_timeline_segments"](source)
        self.assertIsNotNone(self.native["_finite_locked_audio_asset"](finite))
        self.assertFalse(self.native["_finite_video_audio_muted"](finite))
        source["timeline"]["videoAudioEnabled"] = False
        self.assertTrue(self.native["_finite_video_audio_muted"](self.native["_prepare_timeline_segments"](source)))
        source["timeline"]["videoAudioEnabled"] = True
        source["timeline"]["videoClips"][0]["hasAudio"] = False
        finite = self.native["_prepare_timeline_segments"](source)
        self.assertFalse(self.native["_finite_video_audio_muted"](finite))
        self.assertIsNone(self.native["_finite_locked_audio_asset"](finite))


if __name__ == "__main__":
    unittest.main()
