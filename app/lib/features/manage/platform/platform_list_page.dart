import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';

/// The three platform lists. They share one shape: search, a row per record
/// with its status word, and a read-only detail on tap.
enum PlatformListKind {
  tenants(
    title: 'Tenants',
    path: '/platform/workspaces',
    hint: 'Search tenants',
    noun: 'tenant',
    icon: Icons.apartment_rounded,
    filterParam: 'status',
    filters: {
      '': 'All',
      'active': 'Active',
      'suspended': 'Suspended',
      'inactive': 'Inactive',
    },
  ),
  users(
    title: 'Users',
    path: '/platform/users',
    hint: 'Search users',
    noun: 'user',
    icon: Icons.group_outlined,
    filterParam: 'status',
    filters: {'': 'All', 'true': 'Active', 'false': 'Inactive'},
  ),
  audit(
    title: 'Audit log',
    path: '/platform/audit-logs',
    hint: 'Search activity',
    noun: 'event',
    icon: Icons.monitor_heart_outlined,
  );

  const PlatformListKind({
    required this.title,
    required this.path,
    required this.hint,
    required this.noun,
    required this.icon,
    this.filterParam,
    this.filters,
  });
  final String title, path, hint, noun;
  final IconData icon;

  /// The server-side status filter, when the endpoint has one.
  final String? filterParam;
  final Map<String, String>? filters;
}

const _pageSize = 20;

class PlatformListPage extends StatefulWidget {
  const PlatformListPage({super.key, required this.kind});
  final PlatformListKind kind;

  @override
  State<PlatformListPage> createState() => _PlatformListPageState();
}

class _PlatformListPageState extends State<PlatformListPage> {
  ApiClient? _api;
  final _items = <JsonMap>[];
  int _total = 0, _page = 0, _generation = 0;
  bool _loading = true, _loadingMore = false;
  Object? _error;
  String _search = '', _filter = '';
  Timer? _debounce;

  /// Member counts and administrators by tenant id, from the platform
  /// overview (the tenant list itself carries neither).
  Map<String, JsonMap> _tenantHealth = const {};

  PlatformListKind get _kind => widget.kind;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = WorkspaceScope.of(context).api;
    if (api == _api) return;
    _api = api;
    if (_kind == PlatformListKind.tenants) unawaited(_loadTenantHealth());
    unawaited(_reload());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<JsonMap> _fetch(int page) => _api!.get(
    _kind.path,
    query: {
      'page': page,
      'page_size': _pageSize,
      'search': _search.trim(),
      if (_kind.filterParam != null) _kind.filterParam!: _filter,
    },
  );

  Future<void> _loadTenantHealth() async {
    try {
      final overview = await _api!.get('/platform/overview');
      if (!mounted) return;
      setState(
        () => _tenantHealth = {
          for (final item in objectList(overview['workspace_health']))
            textOf(item['id']): item,
        },
      );
    } catch (_) {
      // Without it rows show the code and status only; nothing is guessed.
    }
  }

  Future<void> _reload() async {
    final generation = ++_generation;
    setState(() {
      _loading = _items.isEmpty;
      _error = null;
    });
    try {
      final data = await _fetch(1);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items
          ..clear()
          ..addAll(objectList(data['items']));
        _total = intOf(data['total']);
        _page = 1;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _items.clear();
        _error = error;
        _loading = false;
      });
    }
  }

  Future<void> _showMore() async {
    final generation = _generation;
    setState(() => _loadingMore = true);
    try {
      final data = await _fetch(_page + 1);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items.addAll(objectList(data['items']));
        _total = intOf(data['total']);
        _page += 1;
      });
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _onSearch(String value) {
    _search = value;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), _restart);
  }

  void _onFilter(String value) {
    if (value == _filter) return;
    _filter = value;
    _restart();
  }

  /// A new query: the old rows no longer answer it.
  void _restart() {
    if (!mounted) return;
    setState(_items.clear);
    unawaited(_reload());
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final filters = _kind.filters;
    return Scaffold(
      backgroundColor: colors.paper,
      appBar: AppHeader(paper: true, title: _kind.title, subtitle: 'Platform'),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding,
          children: [
            const SizedBox(height: 4),
            AppSearchField(hint: _kind.hint, onChanged: _onSearch),
            if (filters != null) ...[
              const SizedBox(height: 10),
              Segmented<String>(
                segments: filters,
                selected: _filter,
                onChanged: _onFilter,
              ),
            ],
            const SizedBox(height: 12),
            ..._content(context),
          ],
        ),
      ),
    );
  }

  List<Widget> _content(BuildContext context) {
    if (_loading) return const [LoadingView()];
    if (_error != null) return [ErrorView(error: _error!, onRetry: _reload)];
    if (_items.isEmpty) {
      final narrowed = _search.trim().isNotEmpty || _filter.isNotEmpty;
      return [
        EmptyView(
          icon: _kind.icon,
          title: narrowed ? 'No ${_kind.noun}s match' : 'No ${_kind.noun}s yet',
          message: narrowed ? 'Try another search or filter.' : null,
        ),
      ];
    }
    return [
      ListGroup(
        inset: 58,
        children: [for (final item in _items) _row(context, item)],
      ),
      if (_items.length < _total) ...[
        const SizedBox(height: 12),
        FilledButton(
          style: secondaryButtonStyle(context),
          onPressed: _loadingMore ? null : _showMore,
          child: _loadingMore
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(
                  'Show more · ${groupedNumber(_total - _items.length)} left',
                ),
        ),
      ],
    ];
  }

  Widget _row(BuildContext context, JsonMap item) => switch (_kind) {
    PlatformListKind.tenants => _tenantRow(context, item),
    PlatformListKind.users => _userRow(context, item),
    PlatformListKind.audit => _auditRow(context, item),
  };

  // ── Tenants ──────────────────────────────────────────────────────────────

  Widget _tenantRow(BuildContext context, JsonMap tenant) {
    final id = textOf(tenant['id']);
    final health = _tenantHealth[id];
    final code = textOf(tenant['code']);
    final noAdmin = health != null && health['owner'] == null;
    final meta = [
      // A code generated from an id ("tenant-f02ce776-…") is noise; a
      // chosen one ("local", "finance") is how people know the tenant.
      if (code.isNotEmpty && !_generatedCode.hasMatch(code)) code,
      if (noAdmin)
        'no administrator'
      else if (health != null)
        countOf(intOf(health['member_count']), 'member'),
    ].join(' · ');
    final status = textOf(tenant['status']);
    return ListRow(
      leading: ToneTile(
        tone: toneFor(id),
        icon: Icons.apartment_rounded,
        size: TileSize.small,
      ),
      title: textOf(tenant['name'], code),
      subtitle: meta.isEmpty ? null : meta,
      trailing: noAdmin && status == 'active'
          ? const StatusPill(label: 'Needs admin', tone: StatusTone.warning)
          : _workspaceStatus(status),
      onTap: () => _openTenant(context, tenant, health),
    );
  }

  static final _generatedCode = RegExp(r'^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-');

  void _openTenant(BuildContext context, JsonMap tenant, JsonMap? health) {
    final owner = health == null ? null : objectOf(health['owner']);
    final ownerName = owner == null
        ? ''
        : textOf(owner['display_name'], textOf(owner['email']));
    showAppSheet<void>(
      context,
      title: textOf(tenant['name'], textOf(tenant['code'])),
      subtitle: 'Read-only on mobile',
      scrollable: true,
      builder: (_) => _Facts([
        _Fact('Code', textOf(tenant['code'])),
        _Fact.widget('Status', _workspaceStatus(textOf(tenant['status']))),
        if (health != null) ...[
          _Fact('Members', groupedNumber(intOf(health['member_count']))),
          _Fact.widget(
            'Administrator',
            health['owner'] == null
                ? const StatusPill(
                    label: 'Needs admin',
                    tone: StatusTone.warning,
                  )
                : null,
            value: ownerName,
          ),
          _Fact(
            'Connections',
            groupedNumber(intOf(health['connection_count'])),
          ),
        ],
      ]),
    );
  }

  StatusPill _workspaceStatus(String status) => switch (status) {
    'active' => const StatusPill(label: 'Active', tone: StatusTone.success),
    'suspended' => const StatusPill(
      label: 'Suspended',
      tone: StatusTone.danger,
    ),
    _ => StatusPill(
      label: status.isEmpty || status == 'inactive'
          ? 'Inactive'
          : sentenceCase(status),
      tone: StatusTone.neutral,
    ),
  };

  // ── Users ────────────────────────────────────────────────────────────────

  Widget _userRow(BuildContext context, JsonMap user) {
    final email = textOf(user['email']);
    final name = textOf(user['display_name']).trim();
    return ListRow(
      leading: PersonAvatar(
        name: name.isEmpty ? email : name,
        seed: textOf(user['id']),
        size: 32,
      ),
      title: name.isEmpty ? email : name,
      subtitle: name.isEmpty ? null : email,
      trailing: _userStatus(textOf(user['status'])),
      onTap: () => _openUser(context, user),
    );
  }

  void _openUser(BuildContext context, JsonMap user) {
    final email = textOf(user['email']);
    final name = textOf(user['display_name']).trim();
    String names(Object? value) =>
        objectList(value)
            .map((item) => textOf(item['display_name'], textOf(item['code'])))
            .where((label) => label.isNotEmpty)
            .join(', ');
    final roles = names(user['roles']);
    final groups = names(user['groups']);
    showAppSheet<void>(
      context,
      title: name.isEmpty ? email : name,
      subtitle: 'Read-only on mobile',
      scrollable: true,
      builder: (_) => _Facts([
        _Fact('Email', email),
        _Fact.widget('Status', _userStatus(textOf(user['status']))),
        if (roles.isNotEmpty) _Fact('Roles', roles),
        if (groups.isNotEmpty) _Fact('Groups', groups),
      ]),
    );
  }

  StatusPill _userStatus(String status) => switch (status) {
    'active' => const StatusPill(label: 'Active', tone: StatusTone.success),
    'suspended' => const StatusPill(
      label: 'Suspended',
      tone: StatusTone.danger,
    ),
    _ => const StatusPill(label: 'Inactive', tone: StatusTone.neutral),
  };

  // ── Audit ────────────────────────────────────────────────────────────────

  Widget _auditRow(BuildContext context, JsonMap event) {
    final actor = _actorName(event);
    final workspace = textOf(objectOf(event['workspace'])['name']);
    final meta = [
      actor ?? 'System',
      if (workspace.isNotEmpty) workspace,
      relativeTime(event['created_at']),
    ].where((part) => part.isNotEmpty).join(' · ');
    return ListRow(
      leading: actor == null
          ? const ToneTile(
              tone: Tone.slate,
              icon: Icons.settings_outlined,
              size: TileSize.small,
            )
          : PersonAvatar(
              name: actor,
              seed: textOf(objectOf(event['actor'])['id'], actor),
              size: 32,
            ),
      title: _describeAction(textOf(event['action'])),
      subtitle: meta,
      trailing: _outcome(textOf(event['outcome'])),
      onTap: () => _openEvent(context, event),
    );
  }

  void _openEvent(BuildContext context, JsonMap event) {
    final actor = objectOf(event['actor']);
    final email = textOf(actor['email']);
    final who = _actorName(event);
    final workspace = textOf(objectOf(event['workspace'])['name']);
    final resource = textOf(event['resource_type']);
    showAppSheet<void>(
      context,
      title: _describeAction(textOf(event['action'])),
      subtitle: exactTime(event['created_at']),
      scrollable: true,
      builder: (_) => _Facts([
        _Fact('Who', who ?? 'System'),
        if (who != null && email.isNotEmpty && email != who)
          _Fact('Email', email),
        if (workspace.isNotEmpty) _Fact('Workspace', workspace),
        if (resource.isNotEmpty) _Fact('Affected', sentenceCase(resource)),
        _Fact.widget('Outcome', _outcome(textOf(event['outcome']))),
        _Fact('When', exactTime(event['created_at'])),
      ]),
    );
  }

  static String? _actorName(JsonMap event) {
    final actor = objectOf(event['actor']);
    final name = textOf(actor['display_name']).trim();
    if (name.isNotEmpty) return name;
    final email = textOf(actor['email']).trim();
    return email.isEmpty ? null : email;
  }

  /// `integration.connection.created` → "Created integration connection".
  static String _describeAction(String action) {
    final parts = action.split('.').where((part) => part.isNotEmpty).toList();
    if (parts.isEmpty) return 'Unknown action';
    if (parts.length == 1) return sentenceCase(parts.single);
    final verb = parts.removeLast().replaceAll('_', ' ');
    return '${sentenceCase(verb)} ${parts.join(' ').replaceAll('_', ' ')}';
  }

  static StatusPill _outcome(String outcome) => outcome == 'success'
      ? const StatusPill(label: 'Succeeded', tone: StatusTone.success)
      : const StatusPill(label: 'Failed', tone: StatusTone.danger);
}

/// One read-only fact in a detail sheet: a label, and a value or a status.
class _Fact {
  const _Fact(this.label, this.value) : status = null;
  const _Fact.widget(this.label, this.status, {this.value = ''});
  final String label, value;
  final Widget? status;
}

class _Facts extends StatelessWidget {
  const _Facts(this.facts);
  final List<_Fact> facts;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ListGroup(
      inset: 14,
      children: [
        for (final fact in facts)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(
                  fact.label,
                  style: TextStyle(color: colors.ink3, fontSize: 14),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child:
                        fact.status ??
                        Text(
                          fact.value.isEmpty ? '—' : fact.value,
                          textAlign: TextAlign.right,
                          style: TextStyle(
                            color: colors.ink,
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
