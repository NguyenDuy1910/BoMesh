import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../auth/session.dart';
import '../../../ui/ui.dart';
import 'platform_list_page.dart';

const _tenantRead = 'platform.tenant.read';
const _userRead = 'platform.user.read';
const _auditRead = 'platform.audit.read';
const _healthRead = 'platform.health.read';

/// Read-only platform body, hosted in the account route's separate scope.
/// The parent route owns the always-visible Return to workspace control.
class PlatformOverview extends StatefulWidget {
  const PlatformOverview({super.key});

  @override
  State<PlatformOverview> createState() => _PlatformOverviewState();
}

class _PlatformSummary {
  const _PlatformSummary({
    this.health,
    this.healthError,
    this.activeTenants,
    this.accounts,
  });
  final JsonMap? health;
  final Object? healthError;
  final int? activeTenants, accounts;
}

class _PlatformOverviewState extends State<PlatformOverview> {
  ApiClient? _api;
  AuthSession? _session;
  Future<_PlatformSummary>? _summary;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    if (scope.api == _api && scope.session == _session) return;
    _api = scope.api;
    _session = scope.session;
    _summary = _load();
  }

  bool _can(String permission) =>
      _session?.platformPermissions.contains(permission) ?? false;

  Future<_PlatformSummary> _load() async {
    final api = _api!;
    Future<int?> total(String path, Map<String, Object?> query) async {
      try {
        return intOf((await api.get(path, query: query))['total']);
      } catch (_) {
        // A count is a nicety beside its row; the row still opens the list.
        return null;
      }
    }

    final health = _can(_healthRead)
        ? api
              .get('/platform/health')
              .then<(JsonMap?, Object?)>(
                (value) => (value, null),
                onError: (Object error) => (null, error),
              )
        : Future.value((null, null));
    final tenants = _can(_tenantRead)
        ? total('/platform/workspaces', {'status': 'active', 'page_size': 1})
        : Future<int?>.value();
    final users = _can(_userRead)
        ? total('/platform/users', {'page_size': 1})
        : Future<int?>.value();
    final (healthValue, healthError) = await health;
    return _PlatformSummary(
      health: healthValue,
      healthError: healthError,
      activeTenants: await tenants,
      accounts: await users,
    );
  }

  Future<void> _refresh() async {
    final next = _load();
    setState(() => _summary = next);
    await next;
  }

  void _open(PlatformListKind kind) => Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => PlatformListPage(kind: kind)));

  @override
  Widget build(BuildContext context) => FutureBuilder<_PlatformSummary>(
    future: _summary,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return ErrorView(error: snapshot.error!, onRetry: _refresh);
      }
      final summary = snapshot.data;
      if (summary == null) return const LoadingView();
      final rows = [
        if (_can(_tenantRead))
          ListRow(
            leading: const ToneTile(
              tone: Tone.indigo,
              icon: Icons.apartment_rounded,
              size: TileSize.small,
            ),
            title: 'Workspaces',
            subtitle: summary.activeTenants == null
                ? null
                : '${groupedNumber(summary.activeTenants!)} active',
            onTap: () => _open(PlatformListKind.tenants),
          ),
        if (_can(_userRead))
          ListRow(
            leading: const ToneTile(
              tone: Tone.violet,
              icon: Icons.group_outlined,
              size: TileSize.small,
            ),
            title: 'Users',
            subtitle: summary.accounts == null
                ? null
                : countOf(summary.accounts!, 'account'),
            onTap: () => _open(PlatformListKind.users),
          ),
        if (_can(_auditRead))
          ListRow(
            leading: const ToneTile(
              tone: Tone.sky,
              icon: Icons.monitor_heart_outlined,
              size: TileSize.small,
            ),
            title: 'Audit log',
            subtitle: 'Every workspace',
            onTap: () => _open(PlatformListKind.audit),
          ),
      ];
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding,
          children: [
            if (_can(_healthRead)) ...[
              const SizedBox(height: 8),
              if (summary.health != null)
                _HealthCard(health: summary.health!)
              else
                InlineNotice(
                  text: friendlyError(summary.healthError ?? ''),
                  icon: Icons.monitor_heart_outlined,
                  tone: StatusTone.danger,
                  actionLabel: 'Try again',
                  onAction: _refresh,
                ),
            ],
            if (rows.isNotEmpty) ...[
              SectionLabel('Platform', first: !_can(_healthRead)),
              ListGroup(inset: 58, children: rows),
            ],
          ],
        ),
      );
    },
  );
}

/// System health: the overall word on a card in its colour, then each
/// service with its own dot and response time.
class _HealthCard extends StatelessWidget {
  const _HealthCard({required this.health});
  final JsonMap health;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (tone, word, surface, ink) = switch (textOf(health['status'])) {
      'healthy' => (
        Tone.success,
        'All good',
        colors.successSoft,
        colors.success,
      ),
      'degraded' => (
        Tone.warning,
        'Degraded',
        colors.warningSoft,
        colors.warning,
      ),
      _ => (Tone.danger, 'Down', colors.dangerSoft, colors.danger),
    };
    final services = objectList(health['services']);
    return Semantics(
      container: true,
      label: 'System health: $word',
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: surface,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                ToneTile(
                  tone: tone,
                  icon: Icons.monitor_heart_outlined,
                  size: TileSize.small,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'System health',
                    style: TextStyle(
                      color: colors.ink,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  word,
                  style: TextStyle(
                    color: ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            if (services.isNotEmpty) ...[
              const SizedBox(height: 12),
              TwoColumnGrid(
                gap: 6,
                children: [
                  for (final service in services)
                    _ServiceCell(service: service),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ServiceCell extends StatelessWidget {
  const _ServiceCell({required this.service});
  final JsonMap service;

  static const _names = {
    'api': 'API',
    'qdrant': 'Search',
    'openai_chat': 'Chat model',
    'openrouter_embeddings': 'Embeddings',
    'langfuse': 'Tracing',
  };

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final name = textOf(service['name']);
    final status = textOf(service['status']);
    final latency = service['latency_ms'];
    final (dot, note) = switch (status) {
      'healthy' => (
        colors.success,
        latency is num ? '${latency.round()} ms' : '',
      ),
      'not_configured' => (colors.ink3, 'Not set up'),
      _ => (colors.danger, 'Down'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.canvas.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              _names[name] ?? sentenceCase(name),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.ink, fontSize: 13),
            ),
          ),
          if (note.isNotEmpty) ...[
            const SizedBox(width: 6),
            Text(note, style: TextStyle(color: colors.ink3, fontSize: 12)),
          ],
        ],
      ),
    );
  }
}
