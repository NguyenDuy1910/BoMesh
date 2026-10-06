import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import 'access_sheets.dart';
import 'member_page.dart';
import 'requests_page.dart';

enum _AccessTab {
  members('Members', 'user.manage'),
  groups('Groups', 'group.manage'),
  roles('Roles', 'role.manage');

  const _AccessTab(this.label, this.permission);
  final String label, permission;
}

/// Who is in the workspace and what they can do. Waiting requests sit on top
/// in colour because they block people; members, groups and roles are tabs,
/// each with at most one action.
class AccessPage extends StatefulWidget {
  const AccessPage({super.key});

  @override
  State<AccessPage> createState() => _AccessPageState();
}

class _AccessPageState extends State<AccessPage> with TickerProviderStateMixin {
  List<_AccessTab> _visible = const [];
  TabController? _tabs;
  int _membersVersion = 0, _groupsVersion = 0;

  /// When the longest-waiting request was made, for [_oldestFor] waiting.
  DateTime? _oldest;
  int _oldestFor = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    final visible = [
      for (final tab in _AccessTab.values)
        if (scope.session.can(tab.permission)) tab,
    ];
    if (!_sameTabs(visible)) {
      final previous = _tabs?.index ?? 0;
      _tabs?.dispose();
      _visible = visible;
      _tabs = visible.isEmpty
          ? null
          : (TabController(
              length: visible.length,
              initialIndex: previous.clamp(0, visible.length - 1),
              vsync: this,
            )..addListener(_onTab));
    }
    final waiting = scope.manage.requests ? scope.waitingRequests : 0;
    if (waiting != _oldestFor) {
      _oldestFor = waiting;
      if (waiting > 0) _loadOldest(scope);
    }
  }

  bool _sameTabs(List<_AccessTab> visible) =>
      visible.length == _visible.length &&
      Iterable<int>.generate(visible.length)
          .every((index) => visible[index] == _visible[index]);

  void _onTab() {
    if (!(_tabs?.indexIsChanging ?? true)) setState(() {});
  }

  Future<void> _loadOldest(WorkspaceScope scope) async {
    try {
      final oldest = await oldestWaitingRequest(scope.api, scope.session);
      if (mounted) setState(() => _oldest = oldest);
    } catch (_) {
      // The card still says how many are waiting.
    }
  }

  @override
  void dispose() {
    _tabs?.dispose();
    super.dispose();
  }

  _AccessTab? get _current => _tabs == null ? null : _visible[_tabs!.index];

  Future<void> _addMember(ApiClient api, bool canReadRoles) async {
    final added = await showAddMemberSheet(
      context,
      api: api,
      canReadRoles: canReadRoles,
    );
    if (added == null || !mounted) return;
    setState(() => _membersVersion++);
    showToast(context, '$added can now open this workspace');
  }

  Future<void> _newGroup(ApiClient api) async {
    final created = await showNewGroupSheet(context, api: api);
    if (created == null || !mounted) return;
    setState(() => _groupsVersion++);
    showToast(context, '$created created');
  }

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    final api = scope.api;
    final colors = context.colors;
    final waiting = scope.manage.requests ? scope.waitingRequests : 0;

    final requestsCard = waiting > 0
        ? AttentionCard(
            tone: StatusTone.warning,
            icon: Icons.shield_outlined,
            title: countOf(waiting, 'access request'),
            subtitle: _oldest == null
                ? 'Waiting for your decision'
                : 'Oldest waiting ${_age(_oldest!)}',
            onTap: () => Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => const RequestsPage())),
          )
        : null;

    final Widget content;
    if (_tabs == null) {
      content = EmptyView(
        icon: Icons.shield_outlined,
        title: requestsCard == null
            ? 'Nothing to manage here'
            : 'Requests only',
        message: requestsCard == null
            ? 'Members, groups and roles are managed by people with those permissions.'
            : 'You decide access requests. Members, groups and roles are managed by others.',
      );
    } else {
      content = TabBarView(
        controller: _tabs,
        children: [
          for (final tab in _visible)
            switch (tab) {
              _AccessTab.members => _SearchableList<JsonMap>(
                key: const PageStorageKey('access-members'),
                version: _membersVersion,
                searchHint: 'Search members',
                underFab: true,
                load: (search) => readAllPages(
                  api,
                  '/users',
                  query: {'search': search},
                  limit: 500,
                ),
                empty: (search) => search.isEmpty
                    ? const EmptyView(
                        icon: Icons.person_outline_rounded,
                        title: 'No members yet',
                        message: 'Add someone by the email they sign in to BoMesh with.',
                      )
                    : EmptyView(
                        icon: Icons.search_rounded,
                        title: 'No members match “$search”',
                      ),
                row: (user, reload) => _MemberRow(user: user, onReturn: reload),
              ),
              _AccessTab.groups => _SearchableList<AccessGroup>(
                key: const PageStorageKey('access-groups'),
                version: _groupsVersion,
                searchHint: 'Search groups',
                underFab: true,
                load: (search) async => (await readAllPages(
                  api,
                  '/groups',
                  query: {'search': search},
                  limit: 500,
                )).map(AccessGroup.fromJson).toList(),
                empty: (search) => search.isEmpty
                    ? const EmptyView(
                        icon: Icons.group_outlined,
                        title: 'No groups yet',
                        message: 'Groups let you share collections with many people at once.',
                      )
                    : EmptyView(
                        icon: Icons.search_rounded,
                        title: 'No groups match “$search”',
                      ),
                row: (group, _) => ListRow(
                  leading: ToneTile(
                    tone: toneFor(group.id),
                    icon: Icons.group_outlined,
                    size: TileSize.small,
                  ),
                  title: group.name,
                  subtitle: countOf(group.memberCount, 'member'),
                  trailing: group.active
                      ? null
                      : const StatusPill(
                          label: 'Inactive',
                          tone: StatusTone.neutral,
                        ),
                  chevron: true,
                  onTap: () => showGroupSheet(context, api: api, group: group),
                ),
              ),
              _AccessTab.roles => _SearchableList<AccessRole>(
                key: const PageStorageKey('access-roles'),
                version: 0,
                load: (_) => loadRoles(api),
                empty: (_) => const EmptyView(
                  icon: Icons.shield_outlined,
                  title: 'No roles yet',
                ),
                row: (role, _) => ListRow(
                  leading: const ToneTile(
                    tone: Tone.indigo,
                    icon: Icons.shield_outlined,
                    size: TileSize.small,
                  ),
                  title: role.name,
                  subtitle:
                      '${countOf(role.memberCount, 'member')} · ${role.capabilities}',
                  trailing: !role.active
                      ? const StatusPill(
                          label: 'Inactive',
                          tone: StatusTone.neutral,
                        )
                      : role.isSystem
                      ? const StatusPill(
                          label: 'System',
                          tone: StatusTone.neutral,
                        )
                      : null,
                  chevron: true,
                  onTap: () => showRoleSheet(context, api: api, role: role),
                ),
              ),
            },
        ],
      );
    }

    final fab = switch (_current) {
      _AccessTab.members => AppFab(
        icon: Icons.person_add_alt_1_outlined,
        label: 'Add member',
        onPressed: () => _addMember(api, scope.session.can('role.manage')),
      ),
      _AccessTab.groups => AppFab(
        icon: Icons.group_add_outlined,
        label: 'New group',
        onPressed: () => _newGroup(api),
      ),
      _ => null,
    };

    return Scaffold(
      backgroundColor: colors.paper,
      appBar: AppHeader(
        paper: true,
        title: 'Access',
        bottom: _tabs == null
            ? null
            : AppTabBar(
                controller: _tabs,
                labels: [for (final tab in _visible) tab.label],
              ),
      ),
      floatingActionButton: fab,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (requestsCard != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: requestsCard,
            ),
          Expanded(child: content),
        ],
      ),
    );
  }
}

/// "1 day", "3 days", "5 hours", "12 min".
String _age(DateTime since) {
  final elapsed = DateTime.now().difference(since);
  if (elapsed.inDays >= 1) return countOf(elapsed.inDays, 'day');
  if (elapsed.inHours >= 1) return countOf(elapsed.inHours, 'hour');
  return '${elapsed.inMinutes < 1 ? 1 : elapsed.inMinutes} min';
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.user, required this.onReturn});
  final JsonMap user;
  final VoidCallback onReturn;

  String _names(String key) => [
    for (final value in objectList(user[key]))
      if (textOf(value['display_name']).trim().isNotEmpty)
        textOf(value['display_name']).trim()
      else
        sentenceCase(textOf(value['code'])),
  ].join(', ');

  @override
  Widget build(BuildContext context) {
    final id = textOf(user['id']);
    final name = personName(user);
    final roles = _names('roles'), groups = _names('groups');
    final meta = [
      roles.isEmpty ? 'No role' : roles,
      if (groups.isNotEmpty) groups,
    ].join(' · ');
    return ListRow(
      leading: PersonAvatar(name: name, seed: id),
      title: name,
      subtitle: meta,
      trailing: textOf(user['status']) == 'active'
          ? null
          : const StatusPill(label: 'Suspended', tone: StatusTone.neutral),
      chevron: true,
      onTap: () async {
        await Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => MemberPage(userId: id)));
        onReturn();
      },
    );
  }
}

/// One tab's list: an optional server-side search, then rows on one group,
/// with loading, failure, empty and pull-to-refresh. Bumping [version]
/// reloads it (after something was added).
class _SearchableList<T> extends StatefulWidget {
  const _SearchableList({
    super.key,
    required this.version,
    required this.load,
    required this.empty,
    required this.row,
    this.searchHint,
    this.underFab = false,
  });
  final int version;
  final Future<List<T>> Function(String search) load;
  final Widget Function(String search) empty;
  final Widget Function(T item, VoidCallback reload) row;
  final String? searchHint;
  final bool underFab;

  @override
  State<_SearchableList<T>> createState() => _SearchableListState<T>();
}

class _SearchableListState<T> extends State<_SearchableList<T>>
    with AutomaticKeepAliveClientMixin {
  List<T>? _items;
  Object? _error;
  String _search = '';
  Timer? _debounce;
  int _request = 0;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _SearchableList<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.version != widget.version) _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final request = ++_request;
    setState(() => _error = null);
    try {
      final items = await widget.load(_search.trim());
      if (mounted && request == _request) setState(() => _items = items);
    } catch (error) {
      if (mounted && request == _request) setState(() => _error = error);
    }
  }

  void _onSearch(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (value.trim() == _search.trim()) return;
      _search = value;
      _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final items = _items;
    final search = _search.trim();
    final Widget state;
    if (_error != null && items == null) {
      state = ErrorView(error: _error!, onRetry: _load);
    } else if (items == null) {
      state = const LoadingView();
    } else if (items.isEmpty) {
      state = widget.empty(search);
    } else {
      state = ListGroup(
        children: [for (final item in items) widget.row(item, _load)],
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: kPagePadding.copyWith(
          top: 12,
          bottom: widget.underFab ? kFabClearance : null,
        ),
        children: [
          if (widget.searchHint != null) ...[
            AppSearchField(hint: widget.searchHint!, onChanged: _onSearch),
            const SizedBox(height: 12),
          ],
          if (_error != null && items != null) ...[
            InlineNotice(
              text: friendlyError(_error!),
              tone: StatusTone.danger,
              actionLabel: 'Try again',
              onAction: _load,
            ),
            const SizedBox(height: 12),
          ],
          state,
        ],
      ),
    );
  }
}
