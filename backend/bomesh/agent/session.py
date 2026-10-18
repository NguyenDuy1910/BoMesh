"""Long-lived in-memory runtime aggregate for one conversation session."""

from __future__ import annotations

from dataclasses import replace

from bomesh.agent import (
    ConversationState,
    ContextManager,
    ModelInput,
    SessionConfiguration,
    SessionServices,
    StepContext,
    TurnContext,
    ResourceResolver,
    SandboxRuntime,
)
from bomesh.agent.protocol import Item
from bomesh.agent.tools import ToolRegistry, ToolRouter
from bomesh.agent.transports import ResponseStream, response_stream
from bomesh.observability import NoopTracer, TraceSerializer, Tracer


class Session:
    """Coordinate configuration, dependencies and model-visible context."""

    def __init__(
        self,
        configuration: SessionConfiguration,
        services: SessionServices,
        context_manager: ContextManager,
    ) -> None:
        self.configuration = configuration
        self.services = services
        self.context_manager = context_manager
        self.conversation = ConversationState()
        self._tracer = services.tracer or NoopTracer()

    @property
    def model(self) -> ResponseStream:
        return response_stream(self.services.model)

    @property
    def tool_registry(self) -> ToolRegistry:
        registry = self.services.tool_registry
        if not isinstance(registry, ToolRegistry):
            raise TypeError("session tool_registry must be a ToolRegistry")
        return registry

    @property
    def resource_resolver(self) -> ResourceResolver | None:
        """The request-scoped resolver available to this agent run, if any."""

        return self.services.resource_resolver

    @property
    def tracer(self) -> Tracer:
        """The provider-neutral observability adapter for this session."""

        return self._tracer

    @property
    def sandbox(self) -> SandboxRuntime | None:
        """The optional request-scoped workspace; never model-visible state."""

        return self.services.sandbox_runtime

    async def capture_step_context(self, turn: TurnContext) -> StepContext:
        """Capture the exact settings, environment and tool surface for one step."""

        await self.context_manager.start_turn(
            self.conversation,
            turn,
            self.resource_resolver,
        )
        router = self._tool_router(turn)
        resources = self.context_manager.relevant_resources(turn)
        settings = turn.current_settings
        if settings.model is None:
            settings = replace(
                settings,
                model=self.model.model,
                provider_options=dict(settings.provider_options),
            )
        # Trace start: capture all runtime state considered for this snapshot.
        with self.tracer.span(
            "context.build",
            attributes={"step": turn.model_iteration, "tool_round": turn.tool_round},
            input=TraceSerializer.full(
                TraceSerializer.context_build_input(
                turn,
                conversation=self.conversation.items,
                previous_observations=self.conversation.observations,
                    available_tools=router.model_visible_specs,
                )
            ),
        ) as trace:
            step_context = self.context_manager.capture_step_context(
                turn,
                settings=settings,
                sandbox_guidance=(
                    self.sandbox.guidance if self.sandbox is not None else None
                ),
                tools=router.model_visible_specs,
                tools_enabled=self._tools_enabled(turn),
                resources=resources,
            )
            trace.set_output(
                TraceSerializer.full(
                    TraceSerializer.context_build_output(
                        step_context,
                        considered_input=self.conversation.items,
                        observation_count=len(self.conversation.observations),
                    )
                )
            )
            # Trace end: record the exact StepContext before returning it to the loop.
            return step_context

    def build_model_input(self, step_context: StepContext) -> ModelInput:
        """Materialize the exact request from one immutable runtime snapshot.

        The declared tools are the step's full surface even once the turn's
        tool limits are reached; ``tools_enabled`` then sends
        ``tool_choice: "none"`` so the request prefix stays byte-identical.
        """

        return self.context_manager.build_model_input(
            self.conversation,
            step_context,
            tools=ToolRouter(
                self.tool_registry,
                allowed_names=step_context.tool_names,
                sandbox_available=self.sandbox is not None,
            ).model_visible_specs,
        )

    def record(self, items: tuple[Item, ...]) -> None:
        """Append model or tool output to this turn's ordered conversation state."""

        self.context_manager.record(self.conversation, items)

    def tool_router(self, step_context: StepContext) -> ToolRouter:
        """Recreate the execution router; it executes nothing past the limits."""

        return ToolRouter(
            self.tool_registry,
            allowed_names=(
                step_context.tool_names if step_context.tools_enabled else ()
            ),
            sandbox_available=self.sandbox is not None,
        )

    def _tool_router(self, turn: TurnContext) -> ToolRouter:
        """The conversation's tool surface, independent of the turn's limits."""

        return ToolRouter(
            self.tool_registry,
            allowed_names=turn.environment.agent_context.allowed_tool_names,
            sandbox_available=self.sandbox is not None,
        )

    def _tools_enabled(self, turn: TurnContext) -> bool:
        return (
            turn.tool_round < self.configuration.max_tool_rounds
            and turn.tool_call_count < self.configuration.max_tool_calls
        )


__all__ = ["Session"]
