import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../features/auth/session.dart';
import '../features/chat/chat_page.dart';
import '../features/knowledge/knowledge_page.dart';
import '../features/connections/connections_page.dart';
import '../features/connections/ingestion_activity_page.dart';
import '../features/workspace/workspace_admin_page.dart';
import 'app_theme.dart';

class WorkspaceShell extends StatefulWidget {
  const WorkspaceShell({
    super.key,
    required this.api,
    required this.auth,
    required this.themeMode,
    required this.onCycleTheme,
  });
  final ApiClient api;
  final SessionController auth;
  final ThemeMode themeMode;
  final VoidCallback onCycleTheme;
  @override
  State<WorkspaceShell> createState() => _WorkspaceShellState();
}

class _WorkspaceShellState extends State<WorkspaceShell> {
  int _tab = 0;
  final _visited = <int>{0};
  String? _documentId, _documentTitle;
  int _chatRevision = 0;
  AuthSession get session => widget.auth.session!;
  late final ApiClient _workspaceApi;

  @override
  void initState() {
    super.initState();
    final token = session.accessToken;
    _workspaceApi = ApiClient(baseUrl: widget.api.baseUrl)
      ..accessToken = token
      ..onUnauthorized = () {
        if (widget.auth.session?.accessToken == token) widget.auth.expire();
      };
  }

  @override
  void dispose() {
    _workspaceApi.onUnauthorized = null;
    _workspaceApi.close();
    super.dispose();
  }

  void _select(int index) => setState(() {
    _tab = index;
    _visited.add(index);
  });
  void _askDocument(String id, String title) => setState(() {
    _documentId = id;
    _documentTitle = title;
    _chatRevision++;
    _tab = 0;
  });

  Future<void> _switchWorkspace() async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                'Your workspaces',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final workspace in session.workspaces)
                    ListTile(
                      leading: CircleAvatar(
                        backgroundColor: context.colors.brandSoft,
                        child: Icon(
                          Icons.workspaces_outline,
                          color: context.colors.brand,
                        ),
                      ),
                      title: Text(workspace.name),
                      subtitle: Text(workspace.code),
                      trailing: workspace.id == session.activeWorkspaceId
                          ? Icon(
                              Icons.check_circle,
                              color: context.colors.brand,
                            )
                          : null,
                      onTap: () => Navigator.pop(context, workspace.id),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (selected == null || !mounted) return;
    final changed = await widget.auth.switchWorkspace(selected);
    if (!changed && mounted && widget.auth.error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(widget.auth.error!)));
    }
  }

  Future<void> _profile() async {
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: context.colors.brandSoft,
                    child: Icon(
                      Icons.person_outline,
                      color: context.colors.brand,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          session.displayName ?? 'Your account',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        if (session.email != null)
                          Text(
                            session.email!,
                            style: TextStyle(
                              color: context.colors.textSecondary,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.workspaces_outline),
                title: Text(session.workspaceName),
                subtitle: const Text('Active workspace'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _switchWorkspace();
                },
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.palette_outlined),
                title: const Text('Appearance'),
                subtitle: Text('Current theme: ${widget.themeMode.name}'),
                trailing: const Icon(Icons.brightness_6_outlined),
                onTap: () {
                  Navigator.pop(sheetContext);
                  widget.onCycleTheme();
                },
              ),
              const Divider(height: 32),
              Text(
                'Conversations are saved on this device, separately for each account and workspace.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () async {
                    Navigator.pop(sheetContext);
                    final confirm = await showDialog<bool>(
                      context: context,
                      builder: (context) => AlertDialog(
                        title: const Text('Sign out of this device?'),
                        content: const Text(
                          'Your local conversation history stays private to your account. You can sign in again to continue.',
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(context, false),
                            child: const Text('Cancel'),
                          ),
                          FilledButton(
                            onPressed: () => Navigator.pop(context, true),
                            child: const Text('Sign out'),
                          ),
                        ],
                      ),
                    );
                    if (confirm == true) await widget.auth.signOut();
                  },
                  icon: const Icon(Icons.logout_rounded),
                  label: const Text('Sign out'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final currentSession = session;
    final selected = _tab;
    final pages = <Widget>[
      ChatPage(
        key: ValueKey('chat-$_chatRevision'),
        api: _workspaceApi,
        session: currentSession,
        themeMode: widget.themeMode,
        onCycleTheme: widget.onCycleTheme,
        initialDocumentId: _documentId,
        initialDocumentTitle: _documentTitle,
      ),
      if (_visited.contains(1))
        KnowledgePage(
          api: _workspaceApi,
          session: currentSession,
          onAskDocument: _askDocument,
        )
      else
        const SizedBox.shrink(),
      if (_visited.contains(2))
        WorkspaceAdminPage(
          api: _workspaceApi,
          session: currentSession,
          onOpenKnowledge: () => _select(1),
          onOpenConnections: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              settings: const RouteSettings(name: '/workspace/connections'),
              builder: (_) =>
                  ConnectionsPage(api: _workspaceApi, session: currentSession),
            ),
          ),
          onOpenActivity: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              settings: const RouteSettings(name: '/workspace/sync'),
              builder: (_) => IngestionActivityPage(
                api: _workspaceApi,
                session: currentSession,
              ),
            ),
          ),
          onSessionChanged: widget.auth.refresh,
        )
      else
        const SizedBox.shrink(),
    ];
    final destinations = <NavigationDestination>[
      const NavigationDestination(
        icon: Icon(Icons.chat_bubble_outline_rounded),
        selectedIcon: Icon(Icons.chat_bubble_rounded),
        label: 'Chat',
      ),
      const NavigationDestination(
        icon: Icon(Icons.library_books_outlined),
        selectedIcon: Icon(Icons.library_books_rounded),
        label: 'Library',
      ),
      const NavigationDestination(
        icon: Icon(Icons.space_dashboard_outlined),
        selectedIcon: Icon(Icons.space_dashboard_rounded),
        label: 'Workspace',
      ),
    ];
    return PopScope(
      canPop: selected == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _select(0);
      },
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 1000;
          return Scaffold(
            appBar: AppBar(
              toolbarHeight: 64,
              titleSpacing: 16,
              title: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: widget.auth.busy ? null : _switchWorkspace,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: context.colors.brandSoft,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(
                          Icons.workspaces_outline,
                          color: context.colors.brand,
                          size: 20,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          currentSession.workspaceName,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(Icons.expand_more, size: 20),
                    ],
                  ),
                ),
              ),
              actions: [
                IconButton(
                  tooltip: 'Account and appearance',
                  onPressed: _profile,
                  icon: CircleAvatar(
                    radius: 17,
                    backgroundColor: context.colors.brandSoft,
                    child: Icon(
                      Icons.person_outline,
                      size: 20,
                      color: context.colors.brand,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              bottom: widget.auth.busy
                  ? const PreferredSize(
                      preferredSize: Size.fromHeight(2),
                      child: LinearProgressIndicator(minHeight: 2),
                    )
                  : null,
            ),
            body: Column(
              children: [
                if (widget.auth.notice != null)
                  MaterialBanner(
                    content: Text(widget.auth.notice!),
                    leading: const Icon(Icons.info_outline),
                    actions: [
                      TextButton(
                        onPressed: widget.auth.dismissNotice,
                        child: const Text('Dismiss'),
                      ),
                    ],
                  ),
                Expanded(
                  child: Row(
                    children: [
                      if (wide)
                        NavigationRail(
                          selectedIndex: selected,
                          labelType: NavigationRailLabelType.all,
                          onDestinationSelected: _select,
                          destinations: destinations
                              .map(
                                (d) => NavigationRailDestination(
                                  icon: d.icon,
                                  selectedIcon: d.selectedIcon,
                                  label: Text(d.label),
                                ),
                              )
                              .toList(),
                        ),
                      if (wide) const VerticalDivider(width: 1),
                      Expanded(
                        child: IndexedStack(index: selected, children: pages),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            bottomNavigationBar: wide
                ? null
                : NavigationBar(
                    selectedIndex: selected,
                    onDestinationSelected: _select,
                    destinations: destinations,
                  ),
          );
        },
      ),
    );
  }
}
