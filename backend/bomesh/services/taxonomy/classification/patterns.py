"""``concepts.match_patterns``: RE2-compatible patterns run with bounded ``re``.

A pattern is checked by :func:`validate_pattern` (publish warning W5 and the
classifier use the same check): at most :data:`MAX_PATTERN_LENGTH`
characters, no construct RE2 lacks (backreferences, lookaround, atomic groups,
possessive quantifiers, conditionals). The top-level alternation is split so a
leading inline flag applies to its own alternative, as RE2 reads
``/QĐ-|(?i)^\\s*quyết định``; each alternative compiles with ``re.MULTILINE``
so ``^`` anchors every line of the bounded input (title, number, first heading
lines, :data:`MAX_INPUT_CHARACTERS` at most).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

MAX_PATTERN_LENGTH = 200
#: The text patterns run over: title, number and the first heading lines.
MAX_INPUT_CHARACTERS = 2000
MAX_INPUT_LINES = 12
MAX_LINE_CHARACTERS = 200


@dataclass(frozen=True, slots=True)
class CompiledPattern:
    text: str
    alternatives: tuple[re.Pattern[str], ...]

    def search(self, value: str) -> bool:
        return any(alternative.search(value) for alternative in self.alternatives)


def _alternatives(pattern: str) -> list[str]:
    """Split on top-level ``|`` (outside groups, classes and escapes)."""

    parts: list[str] = []
    depth = 0
    in_class = False
    start = 0
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "\\":
            index += 2
            continue
        if in_class:
            if character == "]":
                in_class = False
        elif character == "[":
            in_class = True
            # ``[]…]`` / ``[^]…]``: a leading ``]`` is a literal.
            if pattern[index + 1 : index + 2] == "^":
                index += 1
            if pattern[index + 1 : index + 2] == "]":
                index += 1
        elif character == "(":
            depth += 1
        elif character == ")":
            depth = max(0, depth - 1)
        elif character == "|" and depth == 0:
            parts.append(pattern[start:index])
            start = index + 1
        index += 1
    parts.append(pattern[start:])
    return parts


_GROUP_OPENERS = {
    "(?=": "lookahead",
    "(?!": "negative lookahead",
    "(?<=": "lookbehind",
    "(?<!": "negative lookbehind",
    "(?>": "atomic group",
    "(?(": "conditional",
    "(?P=": "named backreference",
}


def _unsupported(pattern: str) -> str | None:
    """The first construct RE2 does not support, outside classes and escapes."""

    in_class = False
    index = 0
    previous_quantifier = False
    while index < len(pattern):
        character = pattern[index]
        if character == "\\":
            escaped = pattern[index + 1 : index + 2]
            if not in_class and (escaped.isdigit() and escaped != "0" or escaped == "k"):
                return "backreferences are not supported"
            index += 2
            previous_quantifier = False
            continue
        if in_class:
            if character == "]":
                in_class = False
            index += 1
            continue
        if character == "[":
            in_class = True
            if pattern[index + 1 : index + 2] == "^":
                index += 1
            if pattern[index + 1 : index + 2] == "]":
                index += 1
            index += 1
            previous_quantifier = False
            continue
        if character == "(":
            for opener, name in _GROUP_OPENERS.items():
                if pattern.startswith(opener, index):
                    return f"{name} is not supported"
        if character == "+" and previous_quantifier:
            return "possessive quantifiers are not supported"
        previous_quantifier = character in "*+?}" and not (
            character == "?" and index > 0 and pattern[index - 1] == "("
        )
        if character == "+" and index > 0 and pattern[index - 1] in "*+?}":
            previous_quantifier = False
        index += 1
    return None


def _compile(pattern: str) -> tuple[re.Pattern[str], ...]:
    return tuple(
        re.compile(alternative, re.MULTILINE) for alternative in _alternatives(pattern)
    )


def validate_pattern(pattern: str) -> str | None:
    """Why ``pattern`` cannot be a match pattern, or ``None`` when it can."""

    if not pattern:
        return "the pattern is empty"
    if len(pattern) > MAX_PATTERN_LENGTH:
        return f"the pattern is longer than {MAX_PATTERN_LENGTH} characters"
    problem = _unsupported(pattern)
    if problem is not None:
        return problem
    try:
        _compile(pattern)
    except re.error as error:
        return f"the pattern is not a valid regular expression: {error}"
    return None


def compile_pattern(pattern: str) -> CompiledPattern | None:
    """The compiled pattern; ``None`` when :func:`validate_pattern` rejects it."""

    if validate_pattern(pattern) is not None:
        return None
    return CompiledPattern(pattern, _compile(pattern))


def pattern_input(title: str, number: str | None, lines: Iterable[str]) -> str:
    """The bounded text patterns read: title, number, first heading lines."""

    parts = [title.strip()[:MAX_LINE_CHARACTERS]]
    if number:
        parts.append(number[:MAX_LINE_CHARACTERS])
    count = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        parts.append(stripped[:MAX_LINE_CHARACTERS])
        count += 1
        if count >= MAX_INPUT_LINES:
            break
    return "\n".join(part for part in parts if part)[:MAX_INPUT_CHARACTERS]


__all__ = [
    "MAX_PATTERN_LENGTH",
    "CompiledPattern",
    "compile_pattern",
    "pattern_input",
    "validate_pattern",
]
