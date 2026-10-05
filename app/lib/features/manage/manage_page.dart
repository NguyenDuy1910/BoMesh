import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../knowledge/knowledge_manage_page.dart';
import 'access/access_page.dart';
import 'access/requests_page.dart';
import 'activity_page.dart';
import 'ingestion/ingestion_page.dart';
import 'platform/platform_overview.dart';
import 'settings_page.dart';

enum _Scope { workspace, platform }

/// The Manage tab: operate by exception. What needs a decision comes first,
/// in colour; the workspace at a glance second; the sections last — each only
/// with its permission. Platform admins switch scope with a segmented control.
class ManagePage extends StatefulWidget {
  const ManagePage({super.key});

  @override
  State<ManagePage> createState() => _ManagePageState();
}

class _ManagePageState extends State<ManagePage> {
  _Scope _scope = _Scope.workspace;
  ApiClient? _api;
  String _workspaceId = '';
  JsonMap? _overview;
  Object? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    if (!identical(scope.api, _api) ||
        scope.session.activeWorkspaceId != _workspaceId) {
      _api = scope.api;
      _workspaceId = scope.session.activeWorkspaceId;
      _overview = null;
      _error = null;
      if (scope.manage.overview) _load();
    }
  }

  Future<void> _load() async {
    final workspaceId = _workspaceId;
    try {
      final overview = await _api!.get(
        '/workspaces/${Uri.encodeComponent(workspaceId)}/overview',
        query: {'tz': localTimeZone()},
      );
      if (!mounted || workspaceId != _workspaceId) return;
      setState(() {
        _overview = overview;
        _error = null;
      });
    } catch (error) {
      if (mounted && workspaceId == _workspaceId) {
        setState(() => _error = error);
      }
    }
  }

  void _retry() {
    setState(() => _error = null);
    _load();
  }

  Future<void> _refresh() {
    final scope = WorkspaceScope.of(context);
    return Future.wait([
      if (scope.manage.requests) scope.refreshWaitingRequests(),
      if (scope.manage.overview) _load(),
    ]);
  }

  Future<void> _open(Widget page) async {
    final scope = WorkspaceScope.of(context);
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    if (!mounted) return;
    if (scope.manage.requests) scope.refreshWaitingRequests();
    if (scope.manage.overview) _load();
  }

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    final manage = scope.manage;
    final both = manage.workspace && manage.platform;
    final platform =
        (manage.platform && !manage.workspace) ||
        (both && _scope == _Scope.platform);
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(
        title: 'Manage',
        subtitle: platform
            ? 'Platform · all tenants'
            : scope.session.workspaceName,
        paper: true,
        actions: const [AccountButton()],
      ),
      body: Column(
        children: [
          if (both)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
              child: Segmented<_Scope>(
                segments: const {
                  _Scope.workspace: 'Workspace',
                  _Scope.platform: 'Platform',
                },
                selected: _scope,
                onChanged: (value) => setState(() => _scope = value),
              ),
            ),
          Expanded(
            child: platform ? const PlatformOverview() : _workspace(scope),
          ),
        ],
      ),
    );
  }

  Widget _workspace(WorkspaceScope scope) {
    final manage = scope.manage;
    final overview = _overview;
    if (manage.overview && overview == null) {
      return _error != null
          ? ErrorView(error: _error!, onRetry: _retry)
          : const LoadingView();
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: kPagePadding,
        children: [
          ..._attention(scope, overview),
          if (overview != null) ..._glance(scope, overview),
          ..._sections(scope),
        ],
      ),
    );
  }

  int _waiting(WorkspaceScope scope, JsonMap? overview) {
    if (scope.waitingRequests > 0) return scope.waitingRequests;
    return intOf(objectOf(overview?['attention'])['pending_approval_requests']);
  }

  List<Widget> _attention(WorkspaceScope scope, JsonMap? overview) {
    final manage = scope.manage;
    final waiting = manage.requests ? _waiting(scope, overview) : 0;
    final failed = overview != null && manage.ingestion
        ? intOf(objectOf(overview['attention'])['failed_items'])
        : 0;
    final cards = <Widget>[
      if (waiting > 0)
        AttentionCard(
          tone: StatusTone.warning,
          icon: Icons.shield_outlined,
          title: 'Access requests',
          subtitle: 'Waiting for your decision',
          count: waiting,
          onTap: () => _open(const RequestsPage()),
        ),
      if (failed > 0)
        AttentionCard(
          tone: StatusTone.danger,
          icon: Icons.warning_amber_rounded,
          title: '${countOf(failed, 'document')} failed',
          subtitle: 'They can’t be found in answers yet',
          count: failed,
          onTap: () => _open(const IngestionPage()),
        ),
    ];
    if (cards.isEmpty && overview == null) return const [];
    return [
      const SectionLabel('Needs attention', first: true),
      if (cards.isEmpty)
        const AllClearCard(text: 'Nothing needs you right now')
      else
        for (var index = 0; index < cards.length; index++) ...[
          if (index > 0) const SizedBox(height: 8),
          cards[index],
        ],
    ];
  }

  List<Widget> _glance(WorkspaceScope scope, JsonMap overview) {
    final manage = scope.manage;
    final metrics = objectOf(overview['metrics']);
    final knowledge = objectOf(overview['knowledge']);
    final usage = objectOf(overview['usage']);
    final totals = objectOf(usage['totals']);
    final previous = objectOf(usage['previous']);
    VoidCallback? opens(bool allowed, Widget page) =>
        allowed ? () => _open(page) : null;
    return [
      const SectionLabel('At a glance', aside: 'Last 7 days'),
      TwoColumnGrid(
        children: [
          MetricCard(
            label: 'Documents',
            value: groupedNumber(intOf(knowledge['documents'])),
            note: countOf(intOf(knowledge['collections']), 'collection'),
            onTap: opens(manage.knowledge, const KnowledgeManagePage()),
          ),
          MetricCard.trend(
            label: 'Questions',
            current: intOf(totals['questions']),
            previous: intOf(previous['questions']),
            onTap: opens(manage.activity, const ActivityPage()),
          ),
          MetricCard(
            label: 'Members',
            value: groupedNumber(intOf(metrics['active_users'])),
            note:
                '${countOf(intOf(metrics['active_groups']), 'group')} · ${countOf(intOf(metrics['active_roles']), 'role')}',
            onTap: opens(manage.access, const AccessPage()),
          ),
          MetricCard.trend(
            label: 'Active people',
            current: intOf(totals['active_users']),
            previous: intOf(previous['active_users']),
            onTap: opens(manage.activity, const ActivityPage()),
          ),
        ],
      ),
    ];
  }

  List<Widget> _sections(WorkspaceScope scope) {
    final manage = scope.manage;
    final waiting = manage.requests ? _waiting(scope, _overview) : 0;
    final badge = waiting > 0 ? _CountBadge(count: waiting) : null;
    ListRow row({
      required Tone tone,
      required IconData icon,
      required String title,
      required String subtitle,
      required Widget page,
      Widget? trailing,
    }) => ListRow(
      leading: ToneTile(tone: tone, icon: icon, size: TileSize.small),
      title: title,
      subtitle: subtitle,
      trailing: trailing,
      chevron: true,
      onTap: () => _open(page),
    );
    final rows = <Widget>[
      if (manage.knowledge)
        row(
          tone: Tone.violet,
          icon: Icons.menu_book_outlined,
          title: 'Knowledge',
          subtitle: 'Collections, documents, sharing',
          page: const KnowledgeManagePage(),
        ),
      if (manage.ingestion)
        row(
          tone: Tone.cyan,
          icon: Icons.move_to_inbox_outlined,
          title: 'Ingestion',
          subtitle: 'Make documents searchable',
          page: const IngestionPage(),
        ),
      if (manage.access)
        row(
          tone: Tone.indigo,
          icon: Icons.shield_outlined,
          title: 'Access',
          subtitle: 'Members, groups, roles',
          page: const AccessPage(),
          trailing: badge,
        )
      else if (manage.requests)
        row(
          tone: Tone.indigo,
          icon: Icons.shield_outlined,
          title: 'Access requests',
          subtitle: waiting > 0
              ? 'Waiting for your decision'
              : 'Nothing waiting',
          page: const RequestsPage(),
          trailing: badge,
        ),
      if (manage.activity)
        row(
          tone: Tone.sky,
          icon: Icons.monitor_heart_outlined,
          title: 'Activity',
          subtitle: 'Usage, sign-ins, audit',
          page: const ActivityPage(),
        ),
      if (manage.settings)
        row(
          tone: Tone.slate,
          icon: Icons.settings_outlined,
          title: 'Settings',
          subtitle: 'Workspace name',
          page: const SettingsPage(),
        ),
    ];
    if (rows.isEmpty) return const [];
    return [
      SectionLabel('Workspace', first: !manage.overview && waiting == 0),
      ListGroup(children: rows),
    ];
  }
}

/// The red count beside Access while requests wait.
class _CountBadge extends StatelessWidget {
  const _CountBadge({required this.count});
  final int count;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 22),
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: context.colors.danger,
      borderRadius: BorderRadius.circular(999),
    ),
    alignment: Alignment.center,
    child: Text(
      '$count',
      semanticsLabel: '${countOf(count, 'request')} waiting',
      style: const TextStyle(
        color: Colors.white,
        fontSize: 12,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}
