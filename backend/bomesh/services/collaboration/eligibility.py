"""Request type eligibility rules: a small, safe evaluator for a CEL subset.

A rule's ``condition`` is an expression over two variables: ``requester``
(the filer's profile: ``displayName``, ``email``, ``emailDomain``) and
``fields`` (the request's ``fields`` Struct). True means the rule triggers.

Supported subset:

- literals: integers, decimals, ``"strings"`` / ``'strings'``, ``true``,
  ``false``, ``null`` and lists ``[a, b]``;
- field selection ``fields.days`` and indexing ``fields["days"]``, ``list[0]``;
- ``!``, unary ``-``, ``* / %``, ``+ -`` (numbers; ``+`` also joins strings
  and lists), ``== != < <= > >=``, ``in`` (list membership or map key),
  ``&&`` and ``||``;
- ``has(fields.x)``, ``size(x)`` / ``x.size()``, ``int(x)``, ``double(x)``,
  ``string(x)`` and the string methods ``contains``, ``startsWith``,
  ``endsWith``, ``lowerAscii`` and ``upperAscii``.

As in CEL, a missing field or a type mismatch is an evaluation error, and
``&&``/``||`` absorb an error when the other side decides the result
(``false && error`` is false). A condition that ends in an error does not
trigger. Conditions are parsed on write (INVALID_ARGUMENT when they are not
in the subset) and never executed as code.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from bomesh.errors import InvalidArgument

MAX_CONDITION_LENGTH = 2000
MAX_DEPTH = 32
VARIABLES = frozenset({"requester", "fields"})

_TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
    | (?P<number>\d+\.\d+|\d+)
    | (?P<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<op>&&|\|\||==|!=|<=|>=|[<>!+\-*/%.,()\[\]])
    | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    """,
    re.VERBOSE,
)
_RELATIONS = frozenset({"==", "!=", "<", "<=", ">", ">=", "in"})
_KEYWORDS = {"true": True, "false": False, "null": None}


class EvaluationError(Exception):
    """A CEL runtime error (missing field, wrong type); the rule does not trigger."""


# -- AST ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Literal:
    value: Any


@dataclass(frozen=True, slots=True)
class Variable:
    name: str


@dataclass(frozen=True, slots=True)
class Select:
    operand: Node
    field: str


@dataclass(frozen=True, slots=True)
class Index:
    operand: Node
    index: Node


@dataclass(frozen=True, slots=True)
class ListLiteral:
    elements: tuple[Node, ...]


@dataclass(frozen=True, slots=True)
class Unary:
    operator: str
    operand: Node


@dataclass(frozen=True, slots=True)
class Binary:
    operator: str
    left: Node
    right: Node


@dataclass(frozen=True, slots=True)
class Call:
    function: str
    target: Node | None
    arguments: tuple[Node, ...]


type Node = Literal | Variable | Select | Index | ListLiteral | Unary | Binary | Call


# -- Parser ---------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Token:
    kind: str
    text: str


def _tokenize(text: str) -> list[_Token]:
    tokens: list[_Token] = []
    position = 0
    while position < len(text):
        match = _TOKEN.match(text, position)
        if match is None:
            raise ValueError(f"unexpected character {text[position]!r}")
        position = match.end()
        kind = match.lastgroup or ""
        if kind != "ws":
            tokens.append(_Token(kind, match.group()))
    return tokens


class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self._tokens = tokens
        self._position = 0
        self._depth = 0

    def parse(self) -> Node:
        node = self._or()
        if self._position != len(self._tokens):
            raise ValueError(f"unexpected {self._tokens[self._position].text!r}")
        return node

    def _peek(self) -> str | None:
        if self._position < len(self._tokens):
            return self._tokens[self._position].text
        return None

    def _next(self) -> _Token:
        if self._position >= len(self._tokens):
            raise ValueError("unexpected end of expression")
        token = self._tokens[self._position]
        self._position += 1
        return token

    def _expect(self, text: str) -> None:
        token = self._next()
        if token.text != text:
            raise ValueError(f"expected {text!r}, got {token.text!r}")

    def _nested(self, parse: Callable[[], Node]) -> Node:
        self._depth += 1
        if self._depth > MAX_DEPTH:
            raise ValueError("expression is nested too deeply")
        try:
            return parse()
        finally:
            self._depth -= 1

    def _or(self) -> Node:
        node = self._and()
        while self._peek() == "||":
            self._next()
            node = Binary("||", node, self._and())
        return node

    def _and(self) -> Node:
        node = self._relation()
        while self._peek() == "&&":
            self._next()
            node = Binary("&&", node, self._relation())
        return node

    def _relation(self) -> Node:
        node = self._additive()
        if self._peek() in _RELATIONS:
            operator = self._next().text
            node = Binary(operator, node, self._additive())
        return node

    def _additive(self) -> Node:
        node = self._multiplicative()
        while self._peek() in {"+", "-"}:
            operator = self._next().text
            node = Binary(operator, node, self._multiplicative())
        return node

    def _multiplicative(self) -> Node:
        node = self._unary()
        while self._peek() in {"*", "/", "%"}:
            operator = self._next().text
            node = Binary(operator, node, self._unary())
        return node

    def _unary(self) -> Node:
        if self._peek() in {"!", "-"}:
            operator = self._next().text
            return Unary(operator, self._nested(self._unary))
        return self._member()

    def _member(self) -> Node:
        node = self._primary()
        while self._peek() in {".", "["}:
            if self._next().text == ".":
                name = self._next()
                if name.kind != "ident":
                    raise ValueError(f"expected a field name, got {name.text!r}")
                if self._peek() == "(":
                    node = Call(name.text, node, self._arguments())
                else:
                    node = Select(node, name.text)
            else:
                node = Index(node, self._nested(self._or))
                self._expect("]")
        return node

    def _arguments(self) -> tuple[Node, ...]:
        self._expect("(")
        arguments: list[Node] = []
        if self._peek() != ")":
            arguments.append(self._nested(self._or))
            while self._peek() == ",":
                self._next()
                arguments.append(self._nested(self._or))
        self._expect(")")
        return tuple(arguments)

    def _primary(self) -> Node:
        token = self._next()
        if token.kind == "number":
            return Literal(float(token.text) if "." in token.text else int(token.text))
        if token.kind == "string":
            return Literal(_unquote(token.text))
        if token.text == "(":
            node = self._nested(self._or)
            self._expect(")")
            return node
        if token.text == "[":
            elements: list[Node] = []
            if self._peek() != "]":
                elements.append(self._nested(self._or))
                while self._peek() == ",":
                    self._next()
                    elements.append(self._nested(self._or))
            self._expect("]")
            return ListLiteral(tuple(elements))
        if token.kind == "ident":
            if token.text in _KEYWORDS:
                return Literal(_KEYWORDS[token.text])
            if self._peek() == "(":
                return Call(token.text, None, self._arguments())
            if token.text not in VARIABLES:
                raise ValueError(
                    f"unknown variable {token.text!r}; use requester or fields"
                )
            return Variable(token.text)
        raise ValueError(f"unexpected {token.text!r}")


def _unquote(text: str) -> str:
    body = text[1:-1]
    return re.sub(
        r"\\(.)", lambda match: {"n": "\n", "t": "\t"}.get(match[1], match[1]), body
    )


_FUNCTIONS = {"has": 1, "size": 1, "int": 1, "double": 1, "string": 1}
_METHODS = {
    "contains": 1,
    "startsWith": 1,
    "endsWith": 1,
    "size": 0,
    "lowerAscii": 0,
    "upperAscii": 0,
}


def _check(node: Node) -> None:
    """Reject unknown functions and arities, and ``has`` over anything but a field."""
    match node:
        case Call(function=function, target=None, arguments=arguments):
            if _FUNCTIONS.get(function) != len(arguments):
                raise ValueError(f"unsupported function {function}()")
            if function == "has" and not isinstance(arguments[0], Select):
                raise ValueError(
                    "has() takes a field selection such as has(fields.days)"
                )
            for argument in arguments:
                _check(argument)
        case Call(function=function, target=target, arguments=arguments):
            if _METHODS.get(function) != len(arguments):
                raise ValueError(f"unsupported method .{function}()")
            _check(target)  # type: ignore[arg-type]
            for argument in arguments:
                _check(argument)
        case Select(operand=operand) | Unary(operand=operand):
            _check(operand)
        case Index(operand=operand, index=index):
            _check(operand)
            _check(index)
        case Binary(left=left, right=right):
            _check(left)
            _check(right)
        case ListLiteral(elements=elements):
            for element in elements:
                _check(element)
        case _:
            pass


def compile_condition(condition: str, *, field: str) -> Node:
    """Parse ``condition``; INVALID_ARGUMENT naming ``field`` when it is not in the subset."""
    try:
        if not condition.strip():
            raise ValueError("the condition is empty")
        if len(condition) > MAX_CONDITION_LENGTH:
            raise ValueError(
                f"the condition is longer than {MAX_CONDITION_LENGTH} characters"
            )
        node = _Parser(_tokenize(condition)).parse()
        _check(node)
    except ValueError as exc:
        raise InvalidArgument.for_field(
            field, f"Invalid CEL condition: {exc}."
        ) from None
    return node


# -- Evaluation -----------------------------------------------------------------


def _number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _comparable(left: Any, right: Any) -> bool:
    if _number(left) and _number(right):
        return True
    return type(left) is type(right) and isinstance(left, str | bool)


def _equal(left: Any, right: Any) -> bool:
    if _number(left) and _number(right):
        return left == right
    return (
        type(left) is type(right) and left == right or (left is None and right is None)
    )


class _Evaluator:
    def __init__(self, variables: Mapping[str, Any]) -> None:
        self._variables = variables

    def eval(self, node: Node) -> Any:  # noqa: PLR0911, PLR0912 - one case per node kind
        match node:
            case Literal(value=value):
                return value
            case Variable(name=name):
                return self._variables[name]
            case Select(operand=operand, field=field):
                return _lookup(self.eval(operand), field)
            case Index(operand=operand, index=index):
                return _lookup(self.eval(operand), self.eval(index))
            case ListLiteral(elements=elements):
                return [self.eval(element) for element in elements]
            case Unary(operator="!", operand=operand):
                return not _bool(self.eval(operand))
            case Unary(operand=operand):
                value = self.eval(operand)
                if not _number(value):
                    raise EvaluationError("'-' needs a number")
                return -value
            case Binary(operator="&&", left=left, right=right):
                return self._logical(left, right, decisive=False)
            case Binary(operator="||", left=left, right=right):
                return self._logical(left, right, decisive=True)
            case Binary(operator=operator, left=left, right=right):
                return _binary(operator, self.eval(left), self.eval(right))
            case Call(
                function="has", arguments=(Select(operand=operand, field=field),)
            ):
                container = self.eval(operand)
                if not isinstance(container, Mapping):
                    raise EvaluationError("has() needs a map")
                return field in container
            case Call(function=function, target=target, arguments=arguments):
                values = [self.eval(argument) for argument in arguments]
                if target is not None:
                    values.insert(0, self.eval(target))
                return _call(function, values)
        raise EvaluationError("unsupported expression")

    def _logical(self, left: Node, right: Node, *, decisive: bool) -> bool:
        """``&&`` (decisive False) and ``||`` (decisive True) with CEL error absorption."""
        results: list[bool] = []
        error: EvaluationError | None = None
        for operand in (left, right):
            try:
                value = _bool(self.eval(operand))
            except EvaluationError as exc:
                error = exc
                continue
            if value is decisive:
                return decisive
            results.append(value)
        if error is not None:
            raise error
        return not decisive


def _bool(value: Any) -> bool:
    if not isinstance(value, bool):
        raise EvaluationError("expected a boolean")
    return value


def _lookup(container: Any, key: Any) -> Any:
    if isinstance(container, Mapping):
        if key not in container:
            raise EvaluationError(f"no such key: {key}")
        return container[key]
    if (
        isinstance(container, list)
        and isinstance(key, int)
        and not isinstance(key, bool)
    ):
        if not 0 <= key < len(container):
            raise EvaluationError("index out of range")
        return container[key]
    raise EvaluationError("value cannot be indexed")


def _binary(operator: str, left: Any, right: Any) -> Any:  # noqa: PLR0911
    if operator == "==":
        return _equal(left, right)
    if operator == "!=":
        return not _equal(left, right)
    if operator == "in":
        if isinstance(right, list):
            return any(_equal(left, element) for element in right)
        if isinstance(right, Mapping):
            return left in right
        raise EvaluationError("'in' needs a list or a map")
    if operator in {"<", "<=", ">", ">="}:
        if not _comparable(left, right):
            raise EvaluationError(f"cannot compare with {operator}")
        return {
            "<": left < right,
            "<=": left <= right,
            ">": left > right,
            ">=": left >= right,
        }[operator]
    if operator == "+" and (
        isinstance(left, str)
        and isinstance(right, str)
        or isinstance(left, list)
        and isinstance(right, list)
    ):
        return left + right
    if not (_number(left) and _number(right)):
        raise EvaluationError(f"'{operator}' needs numbers")
    if operator in {"/", "%"} and right == 0:
        raise EvaluationError("division by zero")
    match operator:
        case "+":
            return left + right
        case "-":
            return left - right
        case "*":
            return left * right
        case "/":
            return (
                left // right
                if isinstance(left, int) and isinstance(right, int)
                else left / right
            )
        case _:
            return left % right


def _call(function: str, values: Sequence[Any]) -> Any:  # noqa: PLR0911
    subject = values[0]
    match function:
        case "size":
            if isinstance(subject, str | list | Mapping):
                return len(subject)
        case "int":
            if _number(subject) or isinstance(subject, str):
                try:
                    return int(subject)
                except ValueError:
                    raise EvaluationError("not an integer") from None
        case "double":
            if _number(subject) or isinstance(subject, str):
                try:
                    return float(subject)
                except ValueError:
                    raise EvaluationError("not a number") from None
        case "string":
            if isinstance(subject, bool):
                return "true" if subject else "false"
            if _number(subject) or isinstance(subject, str):
                return str(subject)
        case "contains" | "startsWith" | "endsWith":
            argument = values[1]
            if isinstance(subject, str) and isinstance(argument, str):
                if function == "contains":
                    return argument in subject
                if function == "startsWith":
                    return subject.startswith(argument)
                return subject.endswith(argument)
        case "lowerAscii" | "upperAscii":
            if isinstance(subject, str):
                return subject.lower() if function == "lowerAscii" else subject.upper()
    raise EvaluationError(f"{function}() does not apply to this value")


def triggers(
    node: Node, *, requester: Mapping[str, Any], fields: Mapping[str, Any]
) -> bool:
    """Whether the compiled condition is true for this request (errors do not trigger)."""
    try:
        return _Evaluator({"requester": requester, "fields": fields}).eval(node) is True
    except (EvaluationError, RecursionError):
        return False


__all__ = [
    "MAX_CONDITION_LENGTH",
    "Node",
    "compile_condition",
    "triggers",
]
