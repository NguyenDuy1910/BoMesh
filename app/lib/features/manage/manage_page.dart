import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'access/access_page.dart';
import 'access/requests_page.dart';
import 'activity_page.dart';
import 'ingestion/ingestion_page.dart';
import 'settings_page.dart';


/// Workspace operations, with attention items before navigation and metrics.
class ManagePage extends StatefulWidget {
  const ManagePage({super.key});

  @override
  State<ManagePage> createState() => _ManagePageState();
}

class _ManagePageState extends State<ManagePage> {
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
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(
        title: '',
        paper: true,
        actions: [
          IconButton(
            tooltip: 'Search',
            onPressed: () => scope.openSearch?.call(),
            icon: const Icon(Icons.search_rounded),
          ),
          const AccountButton(),
        ],
      ),
      body: _workspace(scope),
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
          Text('Manage', style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text(scope.session.workspaceName, style: TextStyle(color: context.colors.ink3)),
          const SizedBox(height: 12),
          ..._attention(scope, overview),
          ..._sections(scope),
          if (overview != null) ..._glance(scope, overview),
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
          tone: StatusTone.danger,
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
          onTap: () => _open(const IngestionPage(initialTab: 1)),
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
            onTap: scope.openKnowledge,
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
      if (manage.ingestion)
        row(
          tone: Tone.cyan,
          icon: Icons.move_to_inbox_outlined,
          title: 'Sources',
          subtitle: 'Connected content, sync history, accounts',
          page: const IngestionPage(),
        ),
      if (manage.access)
        row(
          tone: Tone.indigo,
          icon: Icons.shield_outlined,
          title: 'People & access',
          subtitle: 'Members, groups, roles, requests',
          page: const AccessPage(),
          trailing: badge,
        )
      else if (manage.requests)
        row(
          tone: Tone.indigo,
          icon: Icons.shield_outlined,
          title: 'People & access',
          subtitle: waiting > 0
              ? 'Waiting for your decision'
              : 'Nothing waiting',
          page: const AccessPage(),
          trailing: badge,
        ),
      if (manage.activity)
        row(
          tone: Tone.sky,
          icon: Icons.monitor_heart_outlined,
          title: 'Activity',
          subtitle: 'Changes and sign-ins',
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
