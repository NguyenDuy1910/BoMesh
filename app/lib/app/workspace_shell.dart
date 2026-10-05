import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api_client.dart';
import '../features/auth/session.dart';
import '../features/chat/chat_page.dart';
import '../features/knowledge/library_page.dart';
import '../features/manage/access/requests_page.dart';
import '../features/manage/manage_page.dart';
import '../ui/ui.dart';
import 'appearance.dart';
import 'workspace_scope.dart';

enum _Tab { ask, library, manage }

/// The signed-in app: three destinations — Ask, Library and Manage.
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
    unawaited(_countWaiting());
  }

  @override
  void dispose() {
    _workspaceApi.onUnauthorized = null;
    _workspaceApi.close();
    super.dispose();
  }

  List<_Tab> get _tabs => [
    _Tab.ask,
    _Tab.library,
    if (ManageAccess(_session).any) _Tab.manage,
  ];

  void _select(_Tab tab) {
    if (tab == _tab) {
      _navigators[tab]!.currentState?.popUntil((route) => route.isFirst);
      return;
    }
    setState(() {
      _tab = tab;
      _visited.add(tab);
    });
  }

  /// A new chat about one document: the Ask stack starts over with it.
  void _askAboutDocument(String id, String title) {
    setState(() {
      _documentId = id;
      _documentTitle = title;
      _chatRevision++;
      _navigators[_Tab.ask] = GlobalKey<NavigatorState>();
      _tab = _Tab.ask;
    });
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
    ),
    _Tab.library => const LibraryPage(),
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
        _Tab.manage =>
          selected ? Icons.grid_view_rounded : Icons.grid_view_outlined,
      });
      return tab == _Tab.manage
          ? Badge(
              isLabelVisible: _waiting > 0,
              smallSize: 8,
              backgroundColor: colors.danger,
              child: glyph,
            )
          : glyph;
    }

    String label(_Tab tab) => switch (tab) {
      _Tab.ask => 'Ask',
      _Tab.library => 'Library',
      _Tab.manage => 'Manage',
    };

    return WorkspaceScope(
      api: _workspaceApi,
      session: _session,
      auth: widget.auth,
      appearance: widget.appearance,
      askAboutDocument: _askAboutDocument,
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
