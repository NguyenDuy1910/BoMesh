"""google.iam.v1 Policy messages and AnalyzeWorkspaceIamPolicy."""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import Field

from api.aip.messages import ProtoMessage
from bomesh.iam.policy import Binding, Policy
from bomesh.services.workspaces.records import IamAnalysisResult


class BindingMessage(ProtoMessage):
    role: str
    members: list[str]


class PolicyMessage(ProtoMessage):
    version: int | None = None
    bindings: list[BindingMessage] = Field(default_factory=list)
    etag: str | None = None


class GetPolicyOptions(ProtoMessage):
    requested_policy_version: int | None = None


class GetIamPolicyRequest(ProtoMessage):
    options: GetPolicyOptions | None = None


class SetIamPolicyRequest(ProtoMessage):
    policy: PolicyMessage
    update_mask: str | None = None


class TestIamPermissionsRequest(ProtoMessage):
    permissions: list[str]


class TestIamPermissionsResponse(ProtoMessage):
    permissions: list[str]


class IamAnalysisResultMessage(ProtoMessage):
    resource: str
    roles: list[str]


class AnalyzeWorkspaceIamPolicyResponse(ProtoMessage):
    principal: str
    results: list[IamAnalysisResultMessage]


def policy_message(policy: Policy) -> PolicyMessage:
    return PolicyMessage(
        version=policy.version,
        bindings=[
            BindingMessage(role=binding.role, members=list(binding.members))
            for binding in policy.bindings
        ],
        etag=policy.etag,
    )


def bindings_of(policy: PolicyMessage) -> list[Binding]:
    return [Binding(binding.role, tuple(binding.members)) for binding in policy.bindings]


def analysis_message(
    principal: str, results: Sequence[IamAnalysisResult]
) -> AnalyzeWorkspaceIamPolicyResponse:
    return AnalyzeWorkspaceIamPolicyResponse(
        principal=principal,
        results=[
            IamAnalysisResultMessage(resource=result.resource, roles=list(result.roles))
            for result in results
        ],
    )
