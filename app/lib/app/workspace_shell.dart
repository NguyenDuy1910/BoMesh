import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../features/auth/session.dart';
import '../features/chat/chat_page.dart';
import '../features/knowledge/library_page.dart';
import '../features/requests/requests_page.dart';
import 'app_theme.dart';

/// The signed-in app: two places — Chat and Library — and one account menu.
///
/// Workspace administration lives in the web console. The phone keeps only
/// the administrator task that cannot wait: reviewing access requests, which
/// the account button badges when any are waiting.
class WorkspaceShell extends StatefulWidget {
  const WorkspaceShell({super.key, required this.api, required this.auth});
  final ApiClient api;
  final SessionController auth;
  @override
  State<WorkspaceShell> createState() => _WorkspaceShellState();
}

class _WorkspaceShellState extends State<WorkspaceShell> {
  int _tab = 0;
  final _visited = <int>{0};
  String? _documentId, _documentTitle;
  int _chatRevision = 0;
  int _waiting = 0;
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
    _countWaiting();
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

  /// Requests this person can decide right now; drives the account badge.
  Future<void> _countWaiting() async {
    if (!canReviewRequests(session)) return;
    try {
      final count = await countWaitingRequests(_workspaceApi, session);
      if (mounted) setState(() => _waiting = count);
    } catch (_) {
      // The badge is a hint; the Requests screen reports its own errors.
    }
  }

  Future<void> _openRequests() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: '/requests'),
        builder: (_) => RequestsPage(api: _workspaceApi, session: session),
      ),
    );
    await _countWaiting();
  }

  Future<void> _switchWorkspace() async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final workspace in session.workspaces)
              ListTile(
                title: Text(workspace.name),
                trailing: workspace.id == session.activeWorkspaceId
                    ? Icon(Icons.check_rounded, color: context.colors.brand)
                    : null,
                onTap: () => Navigator.pop(sheetContext, workspace.id),
              ),
          ],
        ),
      ),
    );
    if (selected == null || selected == session.activeWorkspaceId || !mounted) {
      return;
    }
    final changed = await widget.auth.switchWorkspace(selected);
    if (!changed && mounted && widget.auth.error != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(widget.auth.error!)));
    }
  }

  Future<void> _signOut() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
          'Your conversations stay saved on this device for when you sign in again.',
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
  }

  Future<void> _account() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: _Avatar(session: session, radius: 20),
              title: Text(session.displayName ?? session.email ?? 'Your account'),
              subtitle: session.displayName != null && session.email != null
                  ? Text(session.email!)
                  : null,
            ),
            const Divider(),
            ListTile(
              leading: const Icon(Icons.workspaces_outline),
              title: Text(session.workspaceName),
              subtitle: const Text('Workspace'),
              trailing: session.workspaces.length > 1
                  ? const Text('Switch')
                  : null,
              onTap: session.workspaces.length > 1
                  ? () => Navigator.pop(sheetContext, 'workspace')
                  : null,
            ),
            ListTile(
              leading: const Icon(Icons.how_to_reg_outlined),
              title: const Text('Access requests'),
              trailing: _waiting > 0
                  ? Badge(label: Text('$_waiting'))
                  : const Icon(Icons.chevron_right),
              onTap: () => Navigator.pop(sheetContext, 'requests'),
            ),
            ListTile(
              leading: const Icon(Icons.logout_rounded),
              title: const Text('Sign out'),
              onTap: () => Navigator.pop(sheetContext, 'sign-out'),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'workspace':
        await _switchWorkspace();
      case 'requests':
        await _openRequests();
      case 'sign-out':
        await _signOut();
    }
  }

  @override
  Widget build(BuildContext context) {
    final account = IconButton(
      tooltip: 'Account',
      onPressed: widget.auth.busy ? null : _account,
      icon: Badge(
        isLabelVisible: _waiting > 0,
        label: Text('$_waiting'),
        child: _Avatar(session: session, radius: 15),
      ),
    );
    final pages = <Widget>[
      ChatPage(
        key: ValueKey('chat-$_chatRevision'),
        api: _workspaceApi,
        session: session,
        account: account,
        initialDocumentId: _documentId,
        initialDocumentTitle: _documentTitle,
      ),
      if (_visited.contains(1))
        LibraryPage(
          api: _workspaceApi,
          session: session,
          account: account,
          onAskDocument: _askDocument,
        )
      else
        const SizedBox.shrink(),
    ];
    const destinations = [
      NavigationDestination(
        icon: Icon(Icons.chat_bubble_outline_rounded),
        selectedIcon: Icon(Icons.chat_bubble_rounded),
        label: 'Chat',
      ),
      NavigationDestination(
        icon: Icon(Icons.folder_outlined),
        selectedIcon: Icon(Icons.folder_rounded),
        label: 'Library',
      ),
    ];
    return PopScope(
      canPop: _tab == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _select(0);
      },
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 1000;
          return Scaffold(
            body: Column(
              children: [
                if (widget.auth.busy) const LinearProgressIndicator(minHeight: 2),
                if (widget.auth.notice != null)
                  MaterialBanner(
                    content: Text(widget.auth.notice!),
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
                          selectedIndex: _tab,
                          labelType: NavigationRailLabelType.all,
                          onDestinationSelected: _select,
                          destinations: [
                            for (final destination in destinations)
                              NavigationRailDestination(
                                icon: destination.icon,
                                selectedIcon: destination.selectedIcon,
                                label: Text(destination.label),
                              ),
                          ],
                        ),
                      if (wide) const VerticalDivider(width: 1),
                      Expanded(
                        child: IndexedStack(index: _tab, children: pages),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            bottomNavigationBar: wide
                ? null
                : NavigationBar(
                    height: 64,
                    selectedIndex: _tab,
                    onDestinationSelected: _select,
                    destinations: destinations,
                  ),
          );
        },
      ),
    );
  }
}

/// The signed-in person, by initial: the same mark in the header and the menu.
class _Avatar extends StatelessWidget {
  const _Avatar({required this.session, required this.radius});
  final AuthSession session;
  final double radius;
  @override
  Widget build(BuildContext context) {
    final name = (session.displayName ?? session.email ?? '?').trim();
    return CircleAvatar(
      radius: radius,
      backgroundColor: context.colors.brandSoft,
      child: Text(
        name.isEmpty ? '?' : name.characters.first.toUpperCase(),
        style: TextStyle(
          color: context.colors.brand,
          fontSize: radius * 0.9,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
