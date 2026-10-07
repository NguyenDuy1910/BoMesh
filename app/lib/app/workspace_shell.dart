import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../features/auth/session.dart';
import '../features/chat/chat_page.dart';
import '../features/inbox/inbox_controller.dart';
import '../features/inbox/inbox_page.dart';
import '../features/search/search_page.dart';
import '../features/knowledge/library_page.dart';
import '../features/manage/access/requests_page.dart';
import '../features/manage/manage_page.dart';
import '../ui/ui.dart';
import 'appearance.dart';
import 'workspace_scope.dart';
import 'app_tour.dart';

enum _Tab { ask, library, inbox, manage }

/// Permission-driven Chat, Knowledge, Inbox and optional Manage destinations.
///
/// Manage appears only for people with a management permission. Each tab
/// keeps its own navigation stack, so going deeper never hides the tab bar
/// and switching tabs keeps where you were; tapping the current tab again
/// returns to its first screen.
class WorkspaceShell extends StatefulWidget {
  const WorkspaceShell({
    super.key,
    required this.api,
    required this.auth,
    required this.appearance,
  });
  final ApiClient api;
  final SessionController auth;
  final AppearanceController appearance;
  @override
  State<WorkspaceShell> createState() => _WorkspaceShellState();
}

class _WorkspaceShellState extends State<WorkspaceShell> {
  _Tab _tab = _Tab.ask;
  final _visited = <_Tab>{_Tab.ask};
  final _navigators = {
    for (final tab in _Tab.values) tab: GlobalKey<NavigatorState>(),
  };
  String? _documentId, _documentTitle;
  String? _collectionId, _collectionTitle, _prompt, _conversationId;
  late final InboxController _inbox;
  int _chatRevision = 0;
  int _waiting = 0;
  late final ApiClient _workspaceApi;

  AuthSession get _session => widget.auth.session!;

  @override
  void initState() {
    super.initState();
    final token = _session.accessToken;
    _workspaceApi = ApiClient(baseUrl: widget.api.baseUrl)
      ..accessToken = token
      ..onUnauthorized = () {
        if (widget.auth.session?.accessToken == token) widget.auth.expire();
      };
    _inbox = InboxController(_workspaceApi, _session)..addListener(_inboxChanged);
    unawaited(_inbox.refresh());
    unawaited(_countWaiting());
    WidgetsBinding.instance.addPostFrameCallback((_) => _firstVisit());
  }

  @override
  void dispose() {
    _inbox.removeListener(_inboxChanged);
    _inbox.dispose();
    _workspaceApi.onUnauthorized = null;
    _workspaceApi.close();
    super.dispose();
  }

  Future<void> _firstVisit() async {
    final preferences = SharedPreferencesAsync();
    final key = 'bomesh.tour:${Uri.encodeComponent(_workspaceApi.baseUrl)}:${Uri.encodeComponent(_session.namespace)}';
    try {
      if (await preferences.getBool(key) == true || !mounted) return;
      final target = _navigators[_Tab.ask]!.currentState?.overlay?.context;
      if (target == null || !target.mounted) return;
      await showAppTour(target);
      await preferences.setBool(key, true);
    } catch (_) {
      // Optional onboarding never blocks the workspace when storage is unavailable.
    }
  }

  List<_Tab> get _tabs => [
    _Tab.ask,
    _Tab.library,
    _Tab.inbox,
    if (ManageAccess(_session).any) _Tab.manage,
  ];

  void _select(_Tab tab) {
    if (tab == _Tab.inbox) unawaited(_inbox.refresh());
    if (tab == _tab) {
      _navigators[tab]!.currentState?.popUntil((route) => route.isFirst);
      return;
    }
    setState(() {
      _tab = tab;
      _visited.add(tab);
    });
  }

  void _askAboutDocument(String id, String title) =>
      _startChat(documentId: id, documentTitle: title);

  void _startChat({
    String? documentId,
    String? documentTitle,
    String? collectionId,
    String? collectionTitle,
    String? prompt,
    String? conversationId,
  }) {
    Navigator.of(context, rootNavigator: true).popUntil((route) => route.isFirst);
    setState(() {
      _documentId = documentId;
      _documentTitle = documentTitle;
      _collectionId = collectionId;
      _collectionTitle = collectionTitle;
      _prompt = prompt;
      _conversationId = conversationId;
      _chatRevision++;
      _navigators[_Tab.ask] = GlobalKey<NavigatorState>();
      _tab = _Tab.ask;
    });
  }

  void _inboxChanged() {
    if (mounted) setState(() {});
  }

  void _openSearch() {
    _navigators[_tab]!.currentState?.push(
      MaterialPageRoute<void>(builder: (_) => const SearchPage()),
    );
  }

  /// Requests waiting for this person's decision; drives the Manage badge.
  Future<void> _countWaiting() async {
    if (!ManageAccess(_session).requests) return;
    try {
      final count = await countWaitingRequests(_workspaceApi, _session);
      if (mounted && count != _waiting) setState(() => _waiting = count);
    } catch (_) {
      // The badge is a hint; the Requests screen reports its own errors.
    }
  }

  Widget _root(_Tab tab) => switch (tab) {
    _Tab.ask => ChatPage(
      key: ValueKey('chat-$_chatRevision'),
      initialDocumentId: _documentId,
      initialDocumentTitle: _documentTitle,
      initialCollectionId: _collectionId,
      initialCollectionTitle: _collectionTitle,
      initialPrompt: _prompt,
      initialConversationId: _conversationId,
    ),
    _Tab.library => const LibraryPage(),
    _Tab.inbox => InboxPage(controller: _inbox),
    _Tab.manage => const ManagePage(),
  };

  /// A hidden tab keeps its stack but stops its tickers, so animations and
  /// pages that poll while visible pause until it is shown again.
  Widget _stack(_Tab tab) {
    if (!_visited.contains(tab)) return const SizedBox.shrink();
    return TickerMode(
      enabled: tab == _tab,
      child: Navigator(
        key: _navigators[tab],
        onGenerateRoute: (settings) => MaterialPageRoute<void>(
          settings: settings,
          builder: (_) => _root(tab),
        ),
      ),
    );
  }

  @override
  void didUpdateWidget(covariant WorkspaceShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_tabs.contains(_tab)) _tab = _Tab.ask;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tabs = _tabs;
    if (!tabs.contains(_tab)) _tab = _Tab.ask;
    final index = tabs.indexOf(_tab);
    Widget icon(_Tab tab, {required bool selected}) {
      final glyph = Icon(switch (tab) {
        _Tab.ask =>
          selected
              ? Icons.chat_bubble_rounded
              : Icons.chat_bubble_outline_rounded,
        _Tab.library =>
          selected ? Icons.menu_book_rounded : Icons.menu_book_outlined,
        _Tab.inbox =>
          selected ? Icons.inbox_rounded : Icons.inbox_outlined,
        _Tab.manage =>
          selected ? Icons.grid_view_rounded : Icons.grid_view_outlined,
      });
      return tab == _Tab.inbox
          ? Badge(
              isLabelVisible: _inbox.unread > 0,
              smallSize: 8,
              label: Text('${_inbox.unread}'),
              backgroundColor: colors.brand,
              child: glyph,
            )
          : glyph;
    }

    String label(_Tab tab) => switch (tab) {
      _Tab.ask => 'Chat',
      _Tab.library => 'Knowledge',
      _Tab.inbox => 'Inbox',
      _Tab.manage => 'Manage',
    };

    return WorkspaceScope(
      api: _workspaceApi,
      session: _session,
      auth: widget.auth,
      appearance: widget.appearance,
      askAboutDocument: _askAboutDocument,
      askAboutCollection: (id, title) =>
          _startChat(collectionId: id, collectionTitle: title),
      askQuestion: (prompt) => _startChat(prompt: prompt),
      openConversation: (id) => _startChat(conversationId: id),
      openSearch: _openSearch,
      openKnowledge: () => _select(_Tab.library),
      waitingRequests: _waiting,
      refreshWaitingRequests: _countWaiting,
      child: PopScope(
        canPop: false,
        // Back goes to the tab's own stack first (which lets a screen such
        // as an open conversation handle it), then to Ask, then leaves.
        onPopInvokedWithResult: (didPop, _) async {
          if (didPop) return;
          final navigator = _navigators[_tab]!.currentState;
          if (navigator != null && await navigator.maybePop()) return;
          if (_tab != _Tab.ask) {
            _select(_Tab.ask);
          } else {
            await SystemNavigator.pop();
          }
        },
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 1000;
            final body = IndexedStack(
              index: _Tab.values.indexOf(_tab),
              children: [for (final tab in _Tab.values) _stack(tab)],
            );
            return Scaffold(
              body: Column(
                children: [
                  if (widget.auth.busy)
                    const LinearProgressIndicator(minHeight: 2),
                  if (widget.auth.notice != null)
                    SafeArea(
                      bottom: false,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                        child: InlineNotice(
                          text: widget.auth.notice!,
                          actionLabel: 'Dismiss',
                          onAction: widget.auth.dismissNotice,
                        ),
                      ),
                    ),
                  Expanded(
                    child: wide
                        ? Row(
                            children: [
                              NavigationRail(
                                selectedIndex: index,
                                labelType: NavigationRailLabelType.all,
                                onDestinationSelected: (value) =>
                                    _select(tabs[value]),
                                destinations: [
                                  for (final tab in tabs)
                                    NavigationRailDestination(
                                      icon: icon(tab, selected: false),
                                      selectedIcon: icon(tab, selected: true),
                                      label: Text(label(tab)),
                                    ),
                                ],
                              ),
                              VerticalDivider(width: 1, color: colors.line),
                              // Phone-shaped screens read best in a column,
                              // not stretched across a desktop.
                              Expanded(
                                child: Center(
                                  child: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxWidth: 760,
                                    ),
                                    child: body,
                                  ),
                                ),
                              ),
                            ],
                          )
                        : body,
                  ),
                ],
              ),
              bottomNavigationBar: wide
                  ? null
                  : DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border(top: BorderSide(color: colors.line)),
                      ),
                      child: NavigationBar(
                        selectedIndex: index,
                        onDestinationSelected: (value) => _select(tabs[value]),
                        destinations: [
                          for (final tab in tabs)
                            NavigationDestination(
                              icon: icon(tab, selected: false),
                              selectedIcon: icon(tab, selected: true),
                              label: label(tab),
                            ),
                        ],
                      ),
                    ),
            );
          },
        ),
      ),
    );
  }
}
