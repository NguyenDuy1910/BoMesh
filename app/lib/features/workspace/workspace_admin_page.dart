import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'workspace_access.dart';
import 'workspace_governance.dart';
import 'workspace_members.dart';
import 'workspace_widgets.dart';

class WorkspaceAdminPage extends StatefulWidget {
  const WorkspaceAdminPage({
    super.key,
    required this.api,
    required this.session,
    required this.onOpenKnowledge,
    required this.onOpenConnections,
    required this.onOpenActivity,
    required this.onSessionChanged,
  });
  final ApiClient api;
  final AuthSession session;
  final VoidCallback onOpenKnowledge, onOpenConnections, onOpenActivity;
  final Future<void> Function() onSessionChanged;
  @override
  State<WorkspaceAdminPage> createState() => _WorkspaceAdminPageState();
}

class _WorkspaceAdminPageState extends State<WorkspaceAdminPage> {
  JsonMap? _overview;
  String? _error;
  bool _loading = false;
  int _request = 0;
  bool get _canOverview => widget.session.can('tenant.read');
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant WorkspaceAdminPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) _load();
  }

  Future<void> _load() async {
    final request = ++_request;
    if (!_canOverview) {
      setState(() {
        _loading = false;
        _error = null;
        _overview = null;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final overview = await widget.api.get(
        '/workspaces/${widget.session.activeWorkspaceId}/overview',
      );
      if (mounted && request == _request) {
        setState(() {
          _overview = overview;
          _loading = false;
        });
      }
    } catch (error) {
      if (mounted && request == _request) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _open(Widget page) async {
    await Navigator.of(context)
        .push<void>(MaterialPageRoute(builder: (_) => page));
    if (mounted) await _load();
  }

  void _members() => _open(
    WorkspaceMembersPage(
      api: widget.api,
      session: widget.session,
      onSessionChanged: widget.onSessionChanged,
    ),
  );
  void _groups() => _open(
    WorkspaceGroupsPage(
      api: widget.api,
      session: widget.session,
      onSessionChanged: widget.onSessionChanged,
    ),
  );
  void _roles() => _open(
    WorkspaceRolesPage(
      api: widget.api,
      session: widget.session,
      onSessionChanged: widget.onSessionChanged,
    ),
  );
  void _approvals() => _open(
    WorkspaceApprovalsPage(
      api: widget.api,
      session: widget.session,
      onSessionChanged: widget.onSessionChanged,
    ),
  );
  void _audit() => _open(WorkspaceAuditPage(api: widget.api));

  Widget _sectionTitle(String title, {VoidCallback? onViewAll}) => Padding(
    padding: const EdgeInsets.only(top: 16, bottom: 16),
    child: Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleLarge),
        ),
        if (onViewAll != null)
          TextButton(onPressed: onViewAll, child: const Text('View all')),
      ],
    ),
  );

  Widget _navigationGrid(
    List<({String title, String subtitle, IconData icon, VoidCallback action})>
    cards,
  ) => LayoutBuilder(
    builder: (context, constraints) => Wrap(
      spacing: 12,
      runSpacing: 12,
      children: cards
          .map(
            (card) => SizedBox(
              width: constraints.maxWidth >= 640
                  ? (constraints.maxWidth - 12) / 2
                  : constraints.maxWidth,
              child: _WorkspaceNavigationCard(
                title: card.title,
                subtitle: card.subtitle,
                icon: card.icon,
                onTap: card.action,
              ),
            ),
          )
          .toList(),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final metrics = objectOf(_overview?['metrics']);
    final attention = objectOf(_overview?['attention']);
    final activity = objectList(_overview?['recent_activity']);
    final resources =
        <({String title, String subtitle, IconData icon, VoidCallback action})>[
          (
            title: 'Knowledge library',
            subtitle: 'Collections, documents, and your personal library.',
            icon: Icons.auto_stories_outlined,
            action: widget.onOpenKnowledge,
          ),
          (
            title: 'Connections',
            subtitle: 'Connected accounts, sources, and sync schedules.',
            icon: Icons.hub_outlined,
            action: widget.onOpenConnections,
          ),
          (
            title: 'Sync activity',
            subtitle: 'Follow ingestion progress and resolve failed runs.',
            icon: Icons.sync_rounded,
            action: widget.onOpenActivity,
          ),
        ];
    final administration =
        <({String title, String subtitle, IconData icon, VoidCallback action})>[
          if (widget.session.can('user.manage'))
            (
              title: 'Members',
              subtitle: 'Add existing accounts and manage workspace access.',
              icon: Icons.people_outline_rounded,
              action: _members,
            ),
          if (widget.session.can('group.manage'))
            (
              title: 'Groups',
              subtitle: 'Organize members and shared collection access.',
              icon: Icons.groups_outlined,
              action: _groups,
            ),
          if (widget.session.can('role.manage'))
            (
              title: 'Roles & permissions',
              subtitle: 'Create precise access with workspace capabilities.',
              icon: Icons.shield_outlined,
              action: _roles,
            ),
          (
            title: 'Approvals',
            subtitle: 'Review collection access and connector requests.',
            icon: Icons.fact_check_outlined,
            action: _approvals,
          ),
          if (widget.session.can('audit.read'))
            (
              title: 'Audit activity',
              subtitle: 'See who changed what, when, and the outcome.',
              icon: Icons.history_rounded,
              action: _audit,
            ),
          (
            title: 'Workspace settings',
            subtitle: 'Workspace name, permanent code, and status.',
            icon: Icons.tune_rounded,
            action: () => _open(
              WorkspaceSettingsPage(
                api: widget.api,
                session: widget.session,
                onSessionChanged: widget.onSessionChanged,
              ),
            ),
          ),
        ];
    return Scaffold(
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: _load,
          child: LayoutBuilder(
            builder: (context, constraints) => ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: EdgeInsets.fromLTRB(
                constraints.maxWidth > 928
                    ? (constraints.maxWidth - 880) / 2
                    : 16,
                24,
                constraints.maxWidth > 928
                    ? (constraints.maxWidth - 880) / 2
                    : 16,
                32,
              ),
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'WORKSPACE',
                            style: Theme.of(context).textTheme.labelMedium
                                ?.copyWith(
                                  color: context.colors.brand,
                                  letterSpacing: 1.3,
                                ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            widget.session.workspaceName,
                            style: Theme.of(context).textTheme.headlineMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Your knowledge, people, and everyday operations.',
                            style: TextStyle(
                              color: context.colors.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (_canOverview)
                      IconButton(
                        tooltip: 'Refresh overview',
                        onPressed: _loading ? null : _load,
                        icon: const Icon(Icons.refresh_rounded),
                      ),
                  ],
                ),
                const SizedBox(height: 24),
                if (_loading)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 24),
                    child: LinearProgressIndicator(),
                  ),
                if (_error != null)
                  WorkspaceNotice(_error!, error: true, onRetry: _load),
                if (_overview != null) ...[
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final values = <(String, String)>[
                        ('active_users', 'Active members'),
                        ('active_groups', 'Active groups'),
                        ('active_roles', 'Active roles'),
                        ('items', 'Collections & documents'),
                        (
                          'active_integration_connections',
                          'Connected accounts',
                        ),
                      ];
                      final columns = constraints.maxWidth >= 760 ? 3 : 2;
                      return Wrap(
                        spacing: 12,
                        runSpacing: 12,
                        children: values
                            .map(
                              (metric) => SizedBox(
                                width:
                                    (constraints.maxWidth -
                                        (columns - 1) * 12) /
                                    columns,
                                child: Container(
                                  padding: const EdgeInsets.all(18),
                                  decoration: BoxDecoration(
                                    color: context.colors.surface,
                                    border: Border.all(
                                      color: context.colors.border,
                                    ),
                                    borderRadius: BorderRadius.circular(18),
                                  ),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        textOf(metrics[metric.$1], '0'),
                                        style: Theme.of(context)
                                            .textTheme
                                            .headlineMedium
                                            ?.copyWith(
                                              fontWeight: FontWeight.w700,
                                            ),
                                      ),
                                      const SizedBox(height: 8),
                                      Text(
                                        metric.$2,
                                        style: TextStyle(
                                          color: context.colors.textSecondary,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            )
                            .toList(),
                      );
                    },
                  ),
                  if ((attention['pending_approval_requests'] as num? ?? 0) >
                          0 ||
                      (attention['failed_items'] as num? ?? 0) > 0) ...[
                    _sectionTitle('Needs attention'),
                    if ((attention['pending_approval_requests'] as num? ?? 0) >
                        0)
                      WorkspaceDirectoryTile(
                        title:
                            '${attention['pending_approval_requests']} pending requests',
                        subtitle: 'Review access and connector decisions.',
                        icon: Icons.fact_check_outlined,
                        onTap: _approvals,
                      ),
                    if ((attention['failed_items'] as num? ?? 0) > 0)
                      WorkspaceDirectoryTile(
                        title: '${attention['failed_items']} failed documents',
                        subtitle:
                            'Open the library to inspect affected documents.',
                        icon: Icons.error_outline_rounded,
                        onTap: widget.onOpenKnowledge,
                      ),
                  ],
                ],
                if (resources.isNotEmpty) ...[
                  _sectionTitle('Your workspace'),
                  _navigationGrid(resources),
                ],
                if (administration.isNotEmpty) ...[
                  _sectionTitle('Manage workspace'),
                  _navigationGrid(administration),
                ],
                if (_overview != null && widget.session.can('audit.read')) ...[
                  _sectionTitle('Recent activity', onViewAll: _audit),
                  if (activity.isEmpty)
                    const WorkspaceEmpty(
                      title: 'A fresh start',
                      message: 'Workspace changes will appear here as your team gets to work.',
                      icon: Icons.history_rounded,
                    )
                  else
                    ...activity
                        .take(5)
                        .map(
                          (event) => WorkspaceDirectoryTile(
                            title: friendlyLabel(textOf(event['action'])),
                            subtitle:
                                '${auditActor(event)} · ${recordedAt(event['created_at'])}',
                            icon: Icons.history_rounded,
                            onTap: () =>
                                _open(WorkspaceAuditDetail(event: event)),
                          ),
                        ),
                ],
                if (widget.session.platformPermissions.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: Text(
                      'This view manages the active workspace only. Platform permissions do not grant workspace access.',
                      style: TextStyle(color: context.colors.textSecondary),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _WorkspaceNavigationCard extends StatelessWidget {
  const _WorkspaceNavigationCard({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.onTap,
  });
  final String title, subtitle;
  final IconData icon;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: context.colors.surface,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
      side: BorderSide(color: context.colors.border),
    ),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: context.colors.brandSoft,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: context.colors.brand, size: 24),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 6),
                  Text(
                    subtitle,
                    style: TextStyle(
                      color: context.colors.textSecondary,
                      height: 1.45,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Icon(
              Icons.arrow_forward_rounded,
              color: context.colors.textSecondary,
              size: 20,
            ),
          ],
        ),
      ),
    ),
  );
}
