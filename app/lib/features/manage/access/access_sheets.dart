import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';

/// Someone named by the IAM API: a display name, or the email when none.
String personName(JsonMap person, [String fallback = 'Someone']) {
  final name = textOf(person['display_name']).trim();
  if (name.isNotEmpty) return name;
  final email = textOf(person['email']).trim();
  return email.isNotEmpty ? email : fallback;
}

/// A workspace role, as `GET /roles` returns it.
class AccessRole {
  AccessRole.fromJson(JsonMap json)
    : id = textOf(json['id']),
      code = textOf(json['code']),
      name = textOf(json['display_name']).trim().isNotEmpty
          ? textOf(json['display_name']).trim()
          : sentenceCase(textOf(json['code'])),
      status = textOf(json['status'], 'active'),
      permissionCodes = [
        for (final code in (json['permission_codes'] as List?) ?? const [])
          '$code',
      ],
      isSystem = json['is_system'] == true,
      memberCount = intOf(json['member_count']);

  final String id, code, name, status;
  final List<String> permissionCodes;
  final bool isSystem;
  final int memberCount;

  bool get active => status == 'active';

  /// What holding the role lets someone do, read off its capabilities.
  String get gist {
    final codes = permissionCodes.toSet();
    if (codes.isEmpty) return 'no capabilities yet';
    if (codes.any(
      const {'user.manage', 'role.manage', 'tenant.manage'}.contains,
    )) {
      return 'can manage the workspace and its members';
    }
    if (codes.any(
      const {
        'knowledge.manage',
        'collection.update',
        'ingestion.run',
        'source.manage',
        'access.manage',
      }.contains,
    )) {
      return 'can add and organise knowledge';
    }
    if (codes.contains('knowledge.read')) return 'can ask and read';
    return 'limited access';
  }

  String get capabilities =>
      countOf(permissionCodes.length, 'capability', 'capabilities');

  /// "Can ask and read · 2 capabilities".
  String get summary => '${sentenceCase(gist)} · $capabilities';

  (Tone, IconData) get mark => switch (gist) {
    'can manage the workspace and its members' => (
      Tone.violet,
      Icons.shield_outlined,
    ),
    'can add and organise knowledge' => (
      Tone.indigo,
      Icons.description_outlined,
    ),
    _ => (Tone.slate, Icons.visibility_outlined),
  };
}

/// Every role of this workspace (`role.manage`).
Future<List<AccessRole>> loadRoles(ApiClient api) async =>
    (await readAllPages(api, '/roles')).map(AccessRole.fromJson).toList();

/// The roles that can be given to someone: active, most limited first.
List<AccessRole> assignableRoles(List<AccessRole> roles) =>
    roles.where((role) => role.active).toList()..sort((a, b) {
      final byReach = a.permissionCodes.length.compareTo(
        b.permissionCodes.length,
      );
      return byReach != 0 ? byReach : a.name.compareTo(b.name);
    });

/// A group, as `GET /groups` (members empty) or `GET /groups/{id}` returns it.
class AccessGroup {
  AccessGroup.fromJson(JsonMap json)
    : id = textOf(json['id']),
      name = textOf(json['display_name']).trim().isNotEmpty
          ? textOf(json['display_name']).trim()
          : textOf(json['code'], 'Group'),
      description = textOf(json['description']).trim(),
      status = textOf(json['status'], 'active'),
      memberCount = intOf(json['member_count']),
      members = objectList(json['members']);

  final String id, name, description, status;
  final int memberCount;
  final List<JsonMap> members;

  bool get active => status == 'active';
}

Future<List<AccessGroup>> loadGroups(ApiClient api) async =>
    (await readAllPages(api, '/groups')).map(AccessGroup.fromJson).toList();

/// Choose one role. Resolves to the chosen role, or null when dismissed.
Future<AccessRole?> pickRole(
  BuildContext context, {
  required String title,
  String? subtitle,
  required List<AccessRole> roles,
  String? selectedId,
}) => showAppSheet<AccessRole>(
  context,
  title: title,
  subtitle: subtitle,
  scrollable: true,
  builder: (sheetContext) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final role in roles)
        SheetOption(
          icon: role.mark.$2,
          tone: role.mark.$1,
          title: role.name,
          subtitle: role.summary,
          selected: role.id == selectedId,
          onTap: () => Navigator.pop(sheetContext, role),
        ),
    ],
  ),
);

/// Choose any number of groups, then Save. Resolves to the chosen ids, or
/// null when dismissed.
Future<Set<String>?> pickGroups(
  BuildContext context, {
  required String title,
  required List<AccessGroup> groups,
  required Set<String> selected,
}) => showAppSheet<Set<String>>(
  context,
  title: title,
  subtitle: 'Groups decide which collections they can open.',
  builder: (_) => _GroupPicker(groups: groups, selected: selected),
);

class _GroupPicker extends StatefulWidget {
  const _GroupPicker({required this.groups, required this.selected});
  final List<AccessGroup> groups;
  final Set<String> selected;

  @override
  State<_GroupPicker> createState() => _GroupPickerState();
}

class _GroupPickerState extends State<_GroupPicker> {
  late final Set<String> _chosen = {...widget.selected};

  void _toggle(String id) => setState(
    () => _chosen.contains(id) ? _chosen.remove(id) : _chosen.add(id),
  );

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Flexible(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final group in widget.groups)
              SheetOption(
                icon: Icons.group_outlined,
                tone: toneFor(group.id),
                title: group.name,
                subtitle: countOf(group.memberCount, 'member'),
                onTap: () => _toggle(group.id),
                trailing: Checkbox(
                  value: _chosen.contains(group.id),
                  onChanged: (_) => _toggle(group.id),
                ),
              ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: () => Navigator.pop(context, _chosen),
        child: const Text('Save'),
      ),
    ],
  );
}

/// Add an existing BoMesh account to this workspace. Resolves to the added
/// member's name, or null when dismissed.
Future<String?> showAddMemberSheet(
  BuildContext context, {
  required ApiClient api,
  required bool canReadRoles,
}) => showAppSheet<String>(
  context,
  title: 'Add a member',
  subtitle: 'They sign in with this email and land in this workspace.',
  builder: (_) => _AddMemberBody(api: api, canReadRoles: canReadRoles),
);

class _AddMemberBody extends StatefulWidget {
  const _AddMemberBody({required this.api, required this.canReadRoles});
  final ApiClient api;
  final bool canReadRoles;

  @override
  State<_AddMemberBody> createState() => _AddMemberBodyState();
}

class _AddMemberBodyState extends State<_AddMemberBody> {
  final _email = TextEditingController();
  List<AccessRole> _roles = const [];
  AccessRole? _role;
  bool _loadingRoles = false, _busy = false;
  String? _rolesError, _error;

  @override
  void initState() {
    super.initState();
    if (widget.canReadRoles) _loadRoles();
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _loadRoles() async {
    setState(() {
      _loadingRoles = true;
      _rolesError = null;
    });
    try {
      final roles = assignableRoles(await loadRoles(widget.api));
      if (!mounted) return;
      setState(() {
        _roles = roles;
        _role = roles.isEmpty ? null : roles.first;
        _loadingRoles = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _rolesError = friendlyError(error);
        _loadingRoles = false;
      });
    }
  }

  Future<void> _chooseRole() async {
    final role = await pickRole(
      context,
      title: 'Role',
      subtitle: 'What they can do in this workspace.',
      roles: _roles,
      selectedId: _role?.id,
    );
    if (role != null && mounted) setState(() => _role = role);
  }

  bool get _valid {
    final email = _email.text.trim();
    return email.contains('@') &&
        !email.endsWith('@') &&
        !email.startsWith('@');
  }

  Future<void> _add() async {
    final email = _email.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final user = await widget.api.post(
        '/users',
        body: {
          'email': email,
          'role_ids': [?_role?.id],
        },
      );
      if (mounted) Navigator.pop(context, personName(user, email));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _explain(error, email);
      });
    }
  }

  String _explain(Object error, String email) {
    if (error is ApiException) {
      if (error.status == 404) {
        return 'There is no BoMesh account for this email yet. Ask them to sign up first, then add them.';
      }
      if (error.status == 409) {
        return error.message.contains('disabled')
            ? 'This BoMesh account is disabled, so it can’t join a workspace.'
            : '$email is already a member of this workspace.';
      }
      if (error.status == 422) return 'Enter a full email address.';
    }
    return friendlyError(error);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _email,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(hintText: 'name@company.com'),
          onChanged: (_) => setState(() => _error = null),
          onSubmitted: (_) {
            if (_valid && !_busy) _add();
          },
        ),
        const SizedBox(height: 8),
        if (!widget.canReadRoles)
          const InlineNotice(
            text: 'They join without a role. Someone who manages roles can give them one.',
          )
        else if (_rolesError != null)
          InlineNotice(
            text: 'Roles could not be loaded. $_rolesError',
            tone: StatusTone.warning,
            actionLabel: 'Try again',
            onAction: _loadRoles,
          )
        else
          SelectRow(
            label: 'Role',
            value: _loadingRoles
                ? 'Loading roles…'
                : _role == null
                ? 'No roles to choose from'
                : '${_role!.name} — ${_role!.gist}',
            icon: Icons.shield_outlined,
            onTap: _loadingRoles || _roles.isEmpty ? null : _chooseRole,
          ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(
            _error!,
            style: TextStyle(color: colors.danger, fontSize: 13.5, height: 1.4),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _valid && !_busy && !_loadingRoles ? _add : null,
          icon: _busy
              ? SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: colors.onBrand,
                  ),
                )
              : const Icon(Icons.person_add_alt_1_outlined, size: 20),
          label: const Text('Add member'),
        ),
      ],
    );
  }
}

/// Create a group. Resolves to the new group's name, or null when dismissed.
Future<String?> showNewGroupSheet(
  BuildContext context, {
  required ApiClient api,
}) => showAppSheet<String>(
  context,
  title: 'New group',
  subtitle: 'Share collections with a group instead of one person at a time.',
  builder: (_) => _NewGroupBody(api: api),
);

class _NewGroupBody extends StatefulWidget {
  const _NewGroupBody({required this.api});
  final ApiClient api;

  @override
  State<_NewGroupBody> createState() => _NewGroupBodyState();
}

class _NewGroupBodyState extends State<_NewGroupBody> {
  final _name = TextEditingController();
  final _description = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final name = _name.text.trim();
    final description = _description.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.post(
        '/groups',
        body: {
          'display_name': name,
          if (description.isNotEmpty) 'description': description,
        },
      );
      if (mounted) Navigator.pop(context, name);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error is ApiException && error.status == 409
            ? 'A group with this name already exists.'
            : friendlyError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final valid = _name.text.trim().isNotEmpty;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _name,
          autofocus: true,
          textCapitalization: TextCapitalization.sentences,
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(hintText: 'Group name'),
          onChanged: (_) => setState(() => _error = null),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _description,
          minLines: 1,
          maxLines: 3,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(
            hintText: 'What it is for (optional)',
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(
            _error!,
            style: TextStyle(color: colors.danger, fontSize: 13.5, height: 1.4),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: valid && !_busy ? _create : null,
          child: _busy
              ? SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: colors.onBrand,
                  ),
                )
              : const Text('Create group'),
        ),
      ],
    );
  }
}

/// A group's detail and full-set membership editor.
Future<void> showGroupSheet(
  BuildContext context, {
  required ApiClient api,
  required AccessGroup group,
}) => showAppSheet<void>(context, title: group.name, scrollable: true,
  builder: (_) => _GroupEditor(api: api, group: group));

class _GroupEditor extends StatefulWidget {
  const _GroupEditor({required this.api, required this.group});
  final ApiClient api;
  final AccessGroup group;
  @override
  State<_GroupEditor> createState() => _GroupEditorState();
}

class _GroupEditorState extends State<_GroupEditor> {
  AccessGroup? _group;
  List<JsonMap> _users = [];
  Set<String> _selected = {};
  final _name = TextEditingController(), _description = TextEditingController();
  bool _busy = false, _started = false, _dirty = false, _active = true;
  String? _error;
  String get _path => '/groups/${Uri.encodeComponent(widget.group.id)}';
  @override
  void didChangeDependencies() { super.didChangeDependencies(); if (!_started) { _started = true; _load(); } }
  @override
  void dispose() { _name.dispose(); _description.dispose(); super.dispose(); }
  Future<void> _load() async {
    setState(() { _busy = true; _error = null; });
    try {
      final group = AccessGroup.fromJson(await widget.api.get(_path));
      if (!mounted) return;
      final users = WorkspaceScope.of(context).session.can('user.manage') ? await readAllPages(widget.api, '/users') : group.members;
      if (!mounted) return;
      setState(() {
        _group = group; _users = users;
        for (final member in group.members) {
          if (!_users.any((user) => user['id'] == member['id'])) _users.add(member);
        }
        _selected = {for (final member in group.members) textOf(member['id'])};
        _name.text = group.name; _description.text = group.description;
        _active = group.active; _dirty = false;
      });
    } catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      await widget.api.patch(_path, body: {'display_name': _name.text.trim(), 'description': _description.text.trim().isEmpty ? null : _description.text.trim(), 'status': _active ? 'active' : 'inactive'});
      await widget.api.put('$_path/members', body: {'user_ids': _selected.toList()});
      if (mounted) Navigator.pop(context);
    } catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (_busy) const LinearProgressIndicator(),
    if (_error != null) InlineNotice(text: _error!, tone: StatusTone.danger, actionLabel: _group == null ? 'Try again' : null, onAction: _group == null ? _load : null),
    if (_group != null) ...[
      TextField(controller: _name, decoration: const InputDecoration(labelText: 'Group name'), onChanged: (_) => setState(() => _dirty = true)),
      TextField(controller: _description, maxLines: 3, decoration: const InputDecoration(labelText: 'Description'), onChanged: (_) => setState(() => _dirty = true)),
      SwitchListTile(title: const Text('Group active'), value: _active, onChanged: _busy ? null : (v) => setState(() { _active = v; _dirty = true; })),
      SectionLabel('Members', aside: '${_selected.length} selected'),
      if (!WorkspaceScope.of(context).session.can('user.manage')) const InlineNotice(text: 'You can remove current members. Adding people requires permission to view the workspace member directory.'),
      for (final user in _users) CheckboxListTile(
        title: Text(personName(user)), subtitle: Text(textOf(user['email'])),
        value: _selected.contains(textOf(user['id'])), onChanged: _busy ? null : (selected) => setState(() {
          if (selected == true) { _selected.add(textOf(user['id'])); } else { _selected.remove(textOf(user['id'])); }
          _dirty = true;
        })),
      if (_dirty) FilledButton(onPressed: _busy || _name.text.trim().isEmpty ? null : _save, child: const Text('Save changes')),
      TextButton(onPressed: _busy ? null : () async {
        if (!await confirmAction(context, title: 'Delete group?', message: 'This removes the group and its membership. There is no restore action.', confirmLabel: 'Delete group', destructive: true) || !mounted) return;
        setState(() => _busy = true);
        try { await widget.api.delete(_path); if (context.mounted) Navigator.pop(context); }
        catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
        finally { if (mounted) setState(() => _busy = false); }
      }, child: const Text('Delete group')),
    ],
  ]);
}

/// Built-in roles are read-only; duplication and creation use the same catalog.
Future<void> showRoleSheet(BuildContext context, {required ApiClient api, required AccessRole role}) =>
  showAppSheet<void>(context, title: role.name, scrollable: true,
    builder: (_) => _RoleEditor(api: api, role: role));

Future<void> showNewRoleSheet(BuildContext context, {required ApiClient api}) =>
  showAppSheet<void>(context, title: 'Create role', scrollable: true,
    builder: (_) => _RoleEditor(api: api));

class _RoleEditor extends StatefulWidget {
  const _RoleEditor({required this.api, this.role});
  final ApiClient api;
  final AccessRole? role;
  @override
  State<_RoleEditor> createState() => _RoleEditorState();
}

class _RoleEditorState extends State<_RoleEditor> {
  final _name = TextEditingController();
  List<JsonMap>? _catalog;
  Set<String> _selected = {};
  bool _busy = false, _dirty = false, _duplicate = false, _active = true;
  AccessRole? _role;
  String? _error;
  bool get _locked => _role?.isSystem == true && !_duplicate;
  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() { _name.dispose(); super.dispose(); }
  Future<void> _load() async {
    setState(() { _busy = true; _error = null; });
    try {
      final role = widget.role == null ? null : AccessRole.fromJson(await widget.api.get('/roles/${Uri.encodeComponent(widget.role!.id)}'));
      final catalog = objectList((await widget.api.get('/permissions'))['items']);
      if (!mounted) return;
      setState(() {
        _catalog = catalog; _role = role; _name.text = role?.name ?? '';
        _selected = role?.permissionCodes.toSet() ?? {};
        _active = role?.active ?? true;
      });
    } catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      final body = <String, dynamic>{'display_name': _name.text.trim(), 'permission_codes': _selected.toList()};
      if (_role == null || _duplicate) {
        await widget.api.post('/roles', body: body);
      } else {
        await widget.api.patch('/roles/${Uri.encodeComponent(_role!.id)}', body: {...body, 'status': _active ? 'active' : 'inactive'});
      }
      if (mounted) Navigator.pop(context);
    } catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  String _area(String code) => switch (code.split('.').first) {
    'tenant' => 'Workspace',
    'user' || 'group' || 'role' || 'access' => 'People & access',
    'source' || 'ingestion' => 'Sources',
    'audit' => 'Activity',
    _ => 'Knowledge',
  };
  @override
  Widget build(BuildContext context) {
    final catalog = _catalog;
    final groups = <String, List<JsonMap>>{};
    for (final item in catalog ?? <JsonMap>[]) {
      groups.putIfAbsent(_area(textOf(item['code'])), () => []).add(item);
    }
    final unknown = _selected.where((code) => !(catalog ?? <JsonMap>[]).any((p) => p['code'] == code)).length;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_busy) const LinearProgressIndicator(),
      if (_error != null) InlineNotice(text: _error!, tone: StatusTone.danger, actionLabel: catalog == null ? 'Try again' : null, onAction: catalog == null ? _load : null),
      if (catalog != null) ...[
        TextField(controller: _name, readOnly: _locked, decoration: const InputDecoration(labelText: 'Role name'), onChanged: (_) => setState(() => _dirty = true)),
        if (_role != null && !_duplicate) ...[
          Text('${countOf(_role!.memberCount, 'member')} · ${_role!.isSystem ? 'Built-in role' : 'Custom role'}'),
          OutlinedButton.icon(onPressed: _busy ? null : () => setState(() {
            _duplicate = true; _dirty = true; _name.text = '${_role!.name} copy';
            final assignable = catalog.map((p) => textOf(p['code'])).toSet();
            _selected = _selected.intersection(assignable);
          }), icon: const Icon(Icons.copy_outlined), label: const Text('Duplicate role')),
        ],
        if (_locked) const InlineNotice(text: 'Built-in roles cannot be changed. Duplicate this role to customize its permissions.'),
        if (unknown > 0) InlineNotice(text: '$unknown existing permissions are outside your assignable catalog. They are preserved when saving; the server enforces your permission ceiling.'),
        if (!_locked && _role != null && !_duplicate) SwitchListTile(title: const Text('Role active'), subtitle: const Text('Inactive roles cannot be assigned to new members.'), value: _active, onChanged: _busy ? null : (v) => setState(() { _active = v; _dirty = true; })),
        for (final group in groups.entries) ...[
          SectionLabel(group.key, aside: '${group.value.where((p) => _selected.contains(p['code'])).length} of ${group.value.length}'),
          for (final permission in group.value) SwitchListTile(
            title: Text(textOf(permission['description'], 'Workspace capability')),
            value: _selected.contains(textOf(permission['code'])),
            onChanged: _locked || _busy ? null : (value) => setState(() {
              if (value) { _selected.add(textOf(permission['code'])); } else { _selected.remove(textOf(permission['code'])); }
              _dirty = true;
            })),
        ],
        if (!_locked && (_dirty || _role == null)) FilledButton(
          onPressed: _busy || _name.text.trim().isEmpty ? null : _save,
          child: Text(_role == null || _duplicate ? 'Create role' : 'Save changes')),
      ],
    ]);
  }
}

Future<Set<String>?> pickRoles(BuildContext context, {required List<AccessRole> roles, required Set<String> selected}) =>
  showAppSheet<Set<String>>(context, title: 'Workspace roles', scrollable: true,
    builder: (_) => _RolePicker(roles: roles, selected: selected));

class _RolePicker extends StatefulWidget {
  const _RolePicker({required this.roles, required this.selected});
  final List<AccessRole> roles;
  final Set<String> selected;
  @override
  State<_RolePicker> createState() => _RolePickerState();
}
class _RolePickerState extends State<_RolePicker> {
  late final _selected = {...widget.selected};
  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    const InlineNotice(text: 'Roles combine their permissions. Changes apply only when you save.'),
    for (final role in widget.roles) CheckboxListTile(title: Text(role.name), subtitle: Text(role.summary),
      value: _selected.contains(role.id), onChanged: !role.active && !_selected.contains(role.id) ? null : (v) => setState(() {
        if (v == true) { _selected.add(role.id); } else { _selected.remove(role.id); }
      })),
    FilledButton(onPressed: () => Navigator.pop(context, _selected), child: const Text('Save roles')),
  ]);
}
