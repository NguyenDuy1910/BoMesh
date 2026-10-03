import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

class CollectionAccessPage extends StatefulWidget {
  const CollectionAccessPage({
    super.key,
    required this.api,
    required this.session,
    required this.collection,
  });
  final ApiClient api;
  final AuthSession session;
  final KnowledgeCollection collection;
  @override
  State<CollectionAccessPage> createState() => _CollectionAccessPageState();
}

class _CollectionAccessPageState extends State<CollectionAccessPage> {
  List<CollectionGrant> _grants = [];
  final Map<String, SharingPrincipal> _principals = {};
  bool _loading = true;
  bool _more = false;
  String? _error;
  String? _busy;
  int _page = 1;
  int _total = 0;
  int _request = 0;
  bool get _current =>
      mounted && widget.api.accessToken == widget.session.accessToken;
  bool get _canSelect => widget.session.canAny(['user.manage', 'group.manage']);

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _request++;
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    final request = ++_request;
    final page = more ? _page + 1 : 1;
    setState(() {
      _loading = !more;
      _more = more;
      _error = null;
    });
    try {
      final value = await widget.api.get(
        '/collections/${Uri.encodeComponent(widget.collection.id)}/access',
        query: {'page': page, 'page_size': 30},
      );
      if (!_current || request != _request) return;
      final grants = objectList(value['items'])
          .map(CollectionGrant.fromJson)
          .toList();
      setState(() {
        _grants = more ? [..._grants, ...grants] : grants;
        _page = page;
        _total = numberOf(value['total']);
        _loading = false;
        _more = false;
      });
      await Future.wait(
        grants.where((grant) => !_principals.containsKey(grant.key)).map((
          grant,
        ) async {
          if (!_current) return;
          final canRead = widget.session.can(
            grant.principalType == 'user' ? 'user.manage' : 'group.manage',
          );
          if (!canRead) return;
          try {
            final value = await widget.api.get(
              '/${grant.principalType == 'user' ? 'users' : 'groups'}/${Uri.encodeComponent(grant.principalId)}',
            );
            if (_current && request == _request) {
              setState(
                () => _principals[grant.key] = SharingPrincipal.fromJson(
                  value,
                  grant.principalType,
                ),
              );
            }
          } catch (_) {
            // A deleted principal can keep a historical grant; its identifier is
            // still shown. Directory failure never grants additional access.
          }
        }),
      );
    } catch (error) {
      if (!_current || request != _request) return;
      setState(() {
        _error = error.toString();
        _loading = false;
        _more = false;
      });
    }
  }

  Future<void> _add() async {
    final choice = await showModalBottomSheet<_GrantChoice>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) =>
          _PrincipalPicker(api: widget.api, session: widget.session),
    );
    if (!_current || choice == null) return;
    _principals[choice.principal.key] = choice.principal;
    await _grant(choice.principal.type, choice.principal.id, choice.role);
  }

  Future<void> _grant(String type, String id, String role) async {
    if (!_current) return;
    setState(() {
      _busy = '$type/$id';
      _error = null;
    });
    try {
      await widget.api.put(
        '/collections/${Uri.encodeComponent(widget.collection.id)}/access/$type/${Uri.encodeComponent(id)}',
        body: {'role': role},
      );
      if (!mounted || !_current) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Collection access updated')),
      );
      await _load();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _busy = null);
    }
  }

  Future<void> _changeRole(CollectionGrant grant) async {
    final principal = _principals[grant.key];
    final role = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: Text(
          'Access for ${principal?.name ?? 'this ${grant.principalType}'}',
        ),
        children: [
          RadioGroup<String>(
            groupValue: grant.role,
            onChanged: (value) => Navigator.pop(context, value),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final role in ['viewer', 'editor', 'owner'])
                  RadioListTile<String>(
                    value: role,
                    title: Text(sentenceCase(role)),
                    subtitle: Text(_roleDescription(role)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
    if (!mounted || !_current || role == null || role == grant.role) return;
    if (grant.principalType == 'user' &&
        grant.principalId == widget.session.userId &&
        grant.role == 'owner') {
      final confirmed = await confirmKnowledgeAction(
        context,
        title: 'Change your own access?',
        message:
            'You may lose the ability to manage sharing for this collection.',
        confirmLabel: 'Change my role',
      );
      if (!_current || !confirmed) return;
    }
    await _grant(grant.principalType, grant.principalId, role);
  }

  Future<void> _revoke(CollectionGrant grant) async {
    final name = _principals[grant.key]?.name ?? 'this ${grant.principalType}';
    final confirmed = await confirmKnowledgeAction(
      context,
      title: 'Remove access?',
      message:
          '$name will lose this direct grant. Access through another group or a parent collection may still apply.',
      confirmLabel: 'Remove access',
    );
    if (!_current || !confirmed) return;
    setState(() {
      _busy = grant.key;
      _error = null;
    });
    try {
      await widget.api.delete(
        '/collections/${Uri.encodeComponent(widget.collection.id)}/access/${grant.principalType}/${Uri.encodeComponent(grant.principalId)}',
      );
      if (!_current) return;
      await _load();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Collection access')),
    floatingActionButton: _canSelect && !_loading
        ? FloatingActionButton.extended(
            onPressed: _busy == null ? _add : null,
            icon: const Icon(Icons.person_add_outlined),
            label: const Text('Share collection'),
          )
        : null,
    body: SafeArea(
      top: false,
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 104),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            Text(
              widget.collection.title,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'Share a collection, not individual documents. Its documents follow the collection’s access.',
              style: TextStyle(
                color: context.colors.textSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 24),
            if (!_canSelect)
              const Padding(
                padding: EdgeInsets.only(bottom: 16),
                child: KnowledgeNotice(
                  title: 'Directory access is restricted',
                  message: 'You can manage existing grants. Selecting another member or group requires workspace directory permissions.',
                  icon: Icons.lock_outline,
                ),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: KnowledgeNotice(
                  title: 'Access could not be updated',
                  message: _error,
                  danger: true,
                  onAction: () => _load(),
                ),
              ),
            if (_loading)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(32),
                  child: CircularProgressIndicator(),
                ),
              )
            else if (_grants.isEmpty)
              const KnowledgeNotice(
                title: 'No direct grants',
                message: 'Workspace capabilities or access inherited from a parent collection may still allow people to read this collection.',
                icon: Icons.group_outlined,
              ),
            for (final grant in _grants)
              Card(
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 8, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          CircleAvatar(
                            backgroundColor: context.colors.brandSoft,
                            foregroundColor: context.colors.brand,
                            child: Icon(
                              grant.principalType == 'group'
                                  ? Icons.groups_outlined
                                  : Icons.person_outline,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _principals[grant.key]?.name ??
                                      '${sentenceCase(grant.principalType)} grant',
                                  style: Theme.of(context).textTheme.titleSmall,
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  _principals[grant.key]?.detail.isNotEmpty ==
                                          true
                                      ? _principals[grant.key]!.detail
                                      : grant.principalId,
                                  style: Theme.of(context).textTheme.bodySmall,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          TextButton.icon(
                            onPressed: _busy == null
                                ? () => _changeRole(grant)
                                : null,
                            icon: const Icon(Icons.manage_accounts_outlined),
                            label: Text(sentenceCase(grant.role)),
                          ),
                          TextButton(
                            onPressed: _busy == null
                                ? () => _revoke(grant)
                                : null,
                            child: Text(
                              'Remove access',
                              style: TextStyle(color: context.colors.danger),
                            ),
                          ),
                        ],
                      ),
                      if (_busy == grant.key) const LinearProgressIndicator(),
                    ],
                  ),
                ),
              ),
            if (!_loading && _grants.length < _total)
              OutlinedButton(
                onPressed: _more ? null : () => _load(more: true),
                child: Text(_more ? 'Loading…' : 'Load more access grants'),
              ),
          ],
        ),
      ),
    ),
  );
}

String _roleDescription(String role) => switch (role) {
  'owner' => 'Read, edit, share and delete the collection',
  'editor' => 'Read, upload and remove documents',
  _ => 'Read documents and use them in answers',
};

class _GrantChoice {
  const _GrantChoice(this.principal, this.role);
  final SharingPrincipal principal;
  final String role;
}

class _PrincipalPicker extends StatefulWidget {
  const _PrincipalPicker({required this.api, required this.session});
  final ApiClient api;
  final AuthSession session;
  @override
  State<_PrincipalPicker> createState() => _PrincipalPickerState();
}

class _PrincipalPickerState extends State<_PrincipalPicker> {
  late String _type = widget.session.can('user.manage') ? 'user' : 'group';
  String _role = 'viewer';
  String _query = '';
  List<SharingPrincipal> _rows = [];
  SharingPrincipal? _selected;
  String? _error;
  bool _loading = true;
  int _page = 1, _total = 0, _request = 0;
  Timer? _debounce;
  bool get _current =>
      mounted && widget.api.accessToken == widget.session.accessToken;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _request++;
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    final request = ++_request;
    final page = more ? _page + 1 : 1;
    setState(() {
      _loading = true;
      _error = null;
      if (!more) _rows = [];
    });
    try {
      final value = await widget.api.get(
        _type == 'user' ? '/users' : '/groups',
        query: {'page': page, 'page_size': 30, 'search': _query.trim()},
      );
      if (!_current || request != _request) return;
      setState(() {
        final rows = objectList(value['items'])
            .map((value) => SharingPrincipal.fromJson(value, _type))
            .toList();
        _rows = more ? [..._rows, ...rows] : rows;
        _total = numberOf(value['total']);
        _page = page;
        _loading = false;
      });
    } catch (error) {
      if (_current && request == _request) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * .85,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Share collection',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                    IconButton(
                      tooltip: 'Close sharing picker',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                if (widget.session.can('user.manage') &&
                    widget.session.can('group.manage')) ...[
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'user', label: Text('People')),
                      ButtonSegment(value: 'group', label: Text('Groups')),
                    ],
                    selected: {_type},
                    onSelectionChanged: (value) {
                      _debounce?.cancel();
                      setState(() {
                        _type = value.first;
                        _selected = null;
                      });
                      _load();
                    },
                  ),
                  const SizedBox(height: 16),
                ],
                TextField(
                  decoration: const InputDecoration(
                    labelText: 'Search workspace directory',
                    prefixIcon: Icon(Icons.search),
                  ),
                  onChanged: (value) {
                    _query = value;
                    _debounce?.cancel();
                    _debounce = Timer(
                      const Duration(milliseconds: 350),
                      () => _load(),
                    );
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                if (_error != null)
                  KnowledgeNotice(
                    title: 'Directory could not be loaded',
                    message: _error,
                    onAction: _load,
                    danger: true,
                  ),
                RadioGroup<String>(
                  groupValue: _selected?.key,
                  onChanged: (key) {
                    setState(
                      () => _selected = _rows
                          .where((principal) => principal.key == key)
                          .firstOrNull,
                    );
                  },
                  child: Column(
                    children: [
                      for (final principal in _rows)
                        RadioListTile<String>(
                          value: principal.key,
                          enabled: principal.active,
                          title: Text(principal.name),
                          subtitle: Text(
                            principal.active
                                ? principal.detail
                                : 'Inactive member or group',
                          ),
                        ),
                    ],
                  ),
                ),
                if (_loading)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                if (!_loading && _rows.isEmpty && _error == null)
                  const KnowledgeNotice(
                    title: 'No matches',
                    message: 'Try another name or email address.',
                  ),
                if (!_loading && _rows.length < _total)
                  TextButton(
                    onPressed: () => _load(more: true),
                    child: const Text('Load more'),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                DropdownButtonFormField<String>(
                  initialValue: _role,
                  decoration: const InputDecoration(
                    labelText: 'Collection role',
                  ),
                  items: [
                    for (final role in ['viewer', 'editor', 'owner'])
                      DropdownMenuItem(
                        value: role,
                        child: Text(sentenceCase(role)),
                      ),
                  ],
                  onChanged: (value) => setState(() => _role = value!),
                ),
                const SizedBox(height: 8),
                Text(
                  _roleDescription(_role),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _selected == null
                        ? null
                        : () => Navigator.pop(
                            context,
                            _GrantChoice(_selected!, _role),
                          ),
                    child: const Text('Grant access'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
