import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../auth/session.dart';
import 'knowledge_models.dart';

/// Share a collection like a folder: add a person or group at the top, change
/// or remove everyone who already has access below. Every choice is saved as
/// soon as it is made.
Future<void> showShareSheet(
  BuildContext context,
  KnowledgeCollection collection,
) {
  final scope = WorkspaceScope.of(context);
  return showAppSheet<void>(
    context,
    title: 'Share “${collection.title}”',
    subtitle: 'Access also reaches the collections inside it.',
    builder: (_) => _ShareBody(
      api: scope.api,
      session: scope.session,
      collection: collection,
    ),
  );
}

/// The same ACL editor used by the collection's Access tab and share sheet.
class CollectionAccessView extends StatelessWidget {
  const CollectionAccessView({super.key, required this.collection});
  final KnowledgeCollection collection;

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    return _ShareBody(
      api: scope.api,
      session: scope.session,
      collection: collection,
      showDone: false,
    );
  }
}

/// One grant on a collection (`CollectionAccess`).
class CollectionGrant {
  CollectionGrant.fromJson(JsonMap value)
    : type = textOf(value['principal_type'], 'user'),
      id = textOf(value['principal_id']),
      name = textOf(
        value['principal_name'],
        'Someone no longer in the workspace',
      ),
      role = textOf(value['role'], 'viewer');
  final String type, id, name, role;
  String get key => '$type:$id';
}

/// Who can open [collectionId]. Needs `collection.share`.
Future<List<CollectionGrant>> readGrants(ApiClient api, String collectionId) =>
    readAllPages(
      api,
      '/collections/${Uri.encodeComponent(collectionId)}/access',
    ).then((items) => items.map(CollectionGrant.fromJson).toList());

const _roles = [
  (
    value: 'viewer',
    label: 'Viewer',
    description: 'Can read it and ask the assistant about it',
    icon: Icons.visibility_outlined,
    tone: Tone.slate,
  ),
  (
    value: 'editor',
    label: 'Editor',
    description: 'Can also add, change and remove its files',
    icon: Icons.insert_drive_file_outlined,
    tone: Tone.indigo,
  ),
  (
    value: 'owner',
    label: 'Owner',
    description: 'Can also decide who else can open it',
    icon: Icons.shield_outlined,
    tone: Tone.violet,
  ),
];

String _roleLabel(String role) =>
    _roles.where((option) => option.value == role).firstOrNull?.label ??
    sentenceCase(role);

/// Pick a role; with [removable], "Remove access" is offered too and
/// resolves to `remove`.
Future<String?> _pickRole(
  BuildContext context, {
  required String title,
  required String current,
  bool removable = false,
}) => showAppSheet<String>(
  context,
  title: title,
  subtitle: removable ? 'Saved as soon as you choose.' : null,
  builder: (sheetContext) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final option in _roles)
        SheetOption(
          icon: option.icon,
          tone: option.tone,
          title: option.label,
          subtitle: option.description,
          selected: option.value == current,
          onTap: () => Navigator.pop(sheetContext, option.value),
        ),
      if (removable)
        SheetOption(
          icon: Icons.person_remove_outlined,
          danger: true,
          title: 'Remove access',
          onTap: () => Navigator.pop(sheetContext, 'remove'),
        ),
    ],
  ),
);

class _ShareBody extends StatefulWidget {
  const _ShareBody({
    required this.api,
    required this.session,
    required this.collection,
    this.showDone = true,
  });
  final ApiClient api;
  final AuthSession session;
  final KnowledgeCollection collection;
  final bool showDone;

  @override
  State<_ShareBody> createState() => _ShareBodyState();
}

class _ShareBodyState extends State<_ShareBody> {
  List<CollectionGrant>? _grants;
  Object? _error;
  String _role = 'viewer';
  String? _busy;

  String get _base =>
      '/collections/${Uri.encodeComponent(widget.collection.id)}/access';

  /// Choosing people needs the workspace directory.
  bool get _canPick =>
      widget.session.canAny(const ['user.manage', 'group.manage']);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final grants = await readGrants(widget.api, widget.collection.id);
      if (mounted) {
        setState(() {
          _grants = grants;
          _error = null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _apply(String key, Future<void> Function() action) async {
    setState(() => _busy = key);
    try {
      await action();
      await _load();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _add() async {
    final held = <String>{
      for (final grant in _grants ?? const <CollectionGrant>[]) grant.key,
    };
    final principal = await showAppSheet<_Principal>(
      context,
      title: 'Add a person or group',
      builder: (_) => _PrincipalPicker(
        api: widget.api,
        session: widget.session,
        held: held,
      ),
    );
    if (principal == null || !mounted) return;
    await _apply(
      'add',
      () => widget.api.put(
        '$_base/${principal.type}/${Uri.encodeComponent(principal.id)}',
        body: {'role': _role},
      ),
    );
  }

  Future<void> _change(CollectionGrant grant) async {
    final choice = await _pickRole(
      context,
      title: 'Role for ${grant.name}',
      current: grant.role,
      removable: true,
    );
    if (choice == null || choice == grant.role || !mounted) return;
    final path = '$_base/${grant.type}/${Uri.encodeComponent(grant.id)}';
    await _apply(
      grant.key,
      choice == 'remove'
          ? () => widget.api.delete(path)
          : () => widget.api.put(path, body: {'role': choice}),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final grants = _grants;
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_canPick)
            Row(
              children: [
                Expanded(
                  child: SelectRow(
                    label: null,
                    value: 'Add a person or group',
                    onTap: _busy == null ? _add : null,
                    trailing: _busy == 'add'
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : null,
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 124,
                  child: SelectRow(
                    label: null,
                    value: _roleLabel(_role),
                    onTap: () async {
                      final role = await _pickRole(
                        context,
                        title: 'Role for who you add',
                        current: _role,
                      );
                      if (role != null && mounted) setState(() => _role = role);
                    },
                  ),
                ),
              ],
            )
          else
            const InlineNotice(
              icon: Icons.admin_panel_settings_outlined,
              text: 'A workspace administrator adds people and groups to it.',
            ),
          const SectionLabel('People with access'),
          if (_error != null)
            InlineNotice(
              tone: StatusTone.danger,
              text: friendlyError(_error!),
              actionLabel: 'Try again',
              onAction: _load,
            )
          else if (grants == null)
            const LoadingView()
          else if (grants.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                'Not shared with anyone yet. People whose workspace role opens every collection can still see it.',
                style: TextStyle(
                  color: colors.ink3,
                  fontSize: 13.5,
                  height: 1.4,
                ),
              ),
            )
          else
            for (final grant in grants)
              ListRow(
                leading: PersonAvatar(name: grant.name, seed: grant.id),
                title: grant.name,
                subtitle: [
                  grant.type == 'group'
                      ? 'Group'
                      : grant.id == widget.session.userId
                      ? 'You'
                      : 'Person',
                  _roleLabel(grant.role),
                ].join(' · '),
                trailing: _busy == grant.key
                    ? const Padding(
                        padding: EdgeInsets.all(10),
                        child: SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : FilledButton(
                        style: secondaryButtonStyle(context, small: true),
                        onPressed: _busy == null ? () => _change(grant) : null,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(_roleLabel(grant.role)),
                            const SizedBox(width: 2),
                            const Icon(Icons.expand_more_rounded, size: 18),
                          ],
                        ),
                      ),
              ),
          const SizedBox(height: 16),
          if (widget.showDone)
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
        ],
      ),
    );
  }
}

class _Principal {
  const _Principal(this.type, this.id, this.name, this.detail);
  final String type, id, name, detail;
  String get key => '$type:$id';
}

/// Search the workspace's people (`user.manage`) and groups (`group.manage`).
class _PrincipalPicker extends StatefulWidget {
  const _PrincipalPicker({
    required this.api,
    required this.session,
    required this.held,
  });
  final ApiClient api;
  final AuthSession session;
  final Set<String> held;

  @override
  State<_PrincipalPicker> createState() => _PrincipalPickerState();
}

class _PrincipalPickerState extends State<_PrincipalPicker> {
  List<_Principal>? _results;
  Object? _error;
  Timer? _debounce;
  int _request = 0;

  @override
  void initState() {
    super.initState();
    _search('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(
      const Duration(milliseconds: 300),
      () => _search(value.trim()),
    );
  }

  Future<void> _search(String query) async {
    final request = ++_request;
    final query0 = {'search': query, 'page_size': 20};
    final reads = <Future<List<_Principal>>>[
      if (widget.session.can('group.manage'))
        widget.api
            .get('/groups', query: query0)
            .then(
              (value) => [
                for (final group in objectList(value['items']))
                  if (textOf(group['status'], 'active') == 'active')
                    _Principal(
                      'group',
                      textOf(group['id']),
                      textOf(group['display_name'], 'Group'),
                      countOf(intOf(group['member_count']), 'member'),
                    ),
              ],
            ),
      if (widget.session.can('user.manage'))
        widget.api
            .get('/users', query: query0)
            .then(
              (value) => [
                for (final user in objectList(value['items']))
                  if (textOf(user['status'], 'active') == 'active')
                    _Principal(
                      'user',
                      textOf(user['id']),
                      textOf(user['display_name']).isNotEmpty
                          ? textOf(user['display_name'])
                          : textOf(user['email'], 'Member'),
                      textOf(user['email']),
                    ),
              ],
            ),
    ];
    final settled = await Future.wait(
      reads.map(
        (read) => read.then<Object>((value) => value, onError: (Object e) => e),
      ),
    );
    if (!mounted || request != _request) return;
    final found = [
      for (final result in settled)
        if (result is List<_Principal>) ...result,
    ].where((principal) => !widget.held.contains(principal.key)).toList();
    setState(() {
      _results = found;
      _error = settled.every((result) => result is! List<_Principal>)
          ? settled.firstOrNull
          : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final results = _results;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSearchField(
          hint: 'Search people and groups',
          autofocus: true,
          onChanged: _onChanged,
        ),
        const SizedBox(height: 8),
        Flexible(
          child: _error != null
              ? InlineNotice(
                  tone: StatusTone.danger,
                  text: friendlyError(_error!),
                )
              : results == null
              ? const LoadingView()
              : results.isEmpty
              ? const EmptyView(
                  icon: Icons.search_off_rounded,
                  title: 'No one to add',
                  message: 'Try another name.',
                )
              : ListView(
                  shrinkWrap: true,
                  children: [
                    for (final principal in results)
                      ListRow(
                        leading: PersonAvatar(
                          name: principal.name,
                          seed: principal.id,
                        ),
                        title: principal.name,
                        subtitle: [
                          principal.type == 'group' ? 'Group' : 'Person',
                          if (principal.detail.isNotEmpty) principal.detail,
                        ].join(' · '),
                        chevron: false,
                        onTap: () => Navigator.pop(context, principal),
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}
