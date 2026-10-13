from __future__ import annotations

import pytest

from animama.domain.text_segmenter import UserResponseSegmenter


def _segments(*deltas: str) -> list[list[str]]:
    """The segments each delta releases, then what ``finish_run`` flushes."""

    segmenter = UserResponseSegmenter()
    released = [[segment.text for segment in segmenter.add_delta("run-1", delta)] for delta in deltas]
    released.append([segment.text for segment in segmenter.finish_run("run-1")])
    return released


def test_japanese_sentences_are_released_as_each_one_completes() -> None:
    assert _segments("好きな季節は秋です。澄んだ", "空気が心地いいです。温かい", "本を楽しみたくなります。") == [
        ["好きな季節は秋です。"],
        ["澄んだ空気が心地いいです。"],
        [],
        ["温かい本を楽しみたくなります。"],
    ]


def test_chinese_sentences_split_at_full_width_marks() -> None:
    assert _segments("你好。今天怎么样？很好！谢谢") == [["你好。", "今天怎么样？", "很好！"], ["谢谢"]]


def test_a_full_width_end_waits_for_the_next_character() -> None:
    """A closing bracket may still follow, so the end of the buffer releases nothing."""

    assert _segments("「おはよう。", "」と言った。次は") == [[], ["「おはよう。」", "と言った。"], ["次は"]]


@pytest.mark.parametrize("marks", ["！！", "？！", "。」", "！』", "？）", "！?", '！"'])
def test_runs_of_full_width_marks_and_closers_stay_with_their_sentence(marks: str) -> None:
    assert _segments(f"本当{marks}そうだね")[0] == [f"本当{marks}"]


def test_a_run_split_across_deltas_stays_with_its_sentence() -> None:
    """Models stream one mark per delta, so each mark waits for the next character."""

    assert _segments("本当！", "？", "そうだね") == [[], [], ["本当！？"], ["そうだね"]]
    assert _segments("嘘でしょ", "？", "！", "」", "次") == [[], [], [], [], ["嘘でしょ？！」"], ["次"]]


def test_a_quoted_full_width_sentence_keeps_its_closing_quote() -> None:
    assert _segments('You say "ありがとう！" to thank a friend.') == [
        ['You say "ありがとう！"'],
        [" to thank a friend."],
    ]


def test_mixed_japanese_and_english_split_at_both_kinds_of_end() -> None:
    assert _segments("今日はいい天気ですね。Let's go outside. 楽しみ") == [
        ["今日はいい天気ですね。", "Let's go outside."],
        [" 楽しみ"],
    ]


@pytest.mark.parametrize(
    ("deltas", "expected"),
    [
        # English needs whitespace after the mark, and keeps its abbreviation rules.
        (("Dr. Smith is here. Then", " more"), [["Dr. Smith is here."], [], [" Then more"]]),
        (("It costs 3.5 euros. Ok",), [["It costs 3.5 euros."], [" Ok"]]),
        # Korean uses ASCII marks with spaces.
        (("안녕하세요. 오늘 어때요? 좋아요",), [["안녕하세요.", " 오늘 어때요?"], [" 좋아요"]]),
        # Spanish keeps its inverted marks inside the sentence.
        (("¡Hola! ¿Cómo estás? Bien",), [["¡Hola!", " ¿Cómo estás?"], [" Bien"]]),
    ],
)
def test_ascii_sentence_ends_are_unchanged(deltas: tuple[str, ...], expected: list[list[str]]) -> None:
    assert _segments(*deltas) == expected
