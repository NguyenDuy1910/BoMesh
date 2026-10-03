import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'workspace_widgets.dart';

class WorkspaceRolesPage extends StatelessWidget {
  const WorkspaceRolesPage({
    super.key,
    required this.api,
    required this.session,
    required this.onSessionChanged,
  });
  final ApiClient api;
  final AuthSession session;
  final Future<void> Function() onSessionChanged;
  @override
  Widget build(BuildContext context) => WorkspacePagedDirectory(
    api: api,
    path: '/roles',
    title: 'Roles',
    description: 'Build workspace access from specific capabilities. Platform permissions are not workspace permissions.',
    createLabel: 'Create role',
    onChanged: onSessionChanged,
    onCreate: session.can('role.manage')
        ? () => Navigator.of(context).push<bool>(
            MaterialPageRoute(
              builder: (_) => _RolePage(api: api, session: session),
            ),
          )
        : null,
    onOpen: (row) => Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) =>
            _RolePage(api: api, session: session, roleId: textOf(row['id'])),
      ),
    ),
    rowBuilder: (context, row, onTap) => WorkspaceDirectoryTile(
      title: directoryName(row),
      subtitle:
          '${stringSet(row['permission_codes']).length} permissions · ${row['is_system'] == true ? 'Built-in role' : 'Custom role'}\n${row['member_count'] ?? 0} assignments',
      icon: Icons.shield_outlined,
      status: textOf(row['status']),
      onTap: onTap,
    ),
  );
}

class _RolePage extends StatefulWidget {
  const _RolePage({required this.api, required this.session, this.roleId});
  final ApiClient api;
  final AuthSession session;
  final String? roleId;
  @override
  State<_RolePage> createState() => _RolePageState();
}

class _RolePageState extends State<_RolePage> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController(),
      _code = TextEditingController(),
      _search = TextEditingController();
  JsonMap? _role;
  List<JsonMap> _permissions = [];
  Set<String> _selected = {};
  bool _loading = true, _busy = false, _held = false;
  String _status = 'active';
  String? _error;
  bool get _create => widget.roleId == null;
  bool get _system => _role?['is_system'] == true;
  bool get _editable => widget.session.can('role.manage') && !_system;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _code.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await Future.wait([
        _create
            ? Future<JsonMap>.value({})
            : widget.api.get('/roles/${widget.roleId}'),
        widget.api.get('/permissions'),
        !_create && widget.session.can('user.manage')
            ? widget.api.get('/users/${widget.session.userId}')
            : Future<JsonMap>.value({}),
      ]);
      if (!mounted) return;
      setState(() {
        _role = result[0];
        _name.text = textOf(_role!['display_name']);
        _code.text = textOf(_role!['code']);
        _selected = stringSet(_role!['permission_codes']);
        _status = textOf(_role!['status'], 'active');
        _permissions = objectList(result[1]['items'])
            .where(
              (permission) =>
                  stringSet(permission['scopes']).contains('tenant') &&
                  widget.session.permissions.contains(
                    textOf(permission['code']),
                  ),
            )
            .toList();
        _held = referenceIds(result[2]['roles']).contains(widget.roleId);
        _loading = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate() || _busy) return;
    final patch = <String, dynamic>{};
    if (_create) {
      patch.addAll({
        'code': _code.text.trim(),
        'display_name': _name.text.trim(),
        'permission_codes': _selected.toList(),
      });
    } else {
      if (_name.text.trim() != _role!['display_name']) {
        patch['display_name'] = _name.text.trim();
      }
      if (_status != _role!['status']) patch['status'] = _status;
      if (!setEquals(_selected, stringSet(_role!['permission_codes']))) {
        patch['permission_codes'] = _selected.toList();
      }
      if (patch.isEmpty) {
        Navigator.pop(context, false);
        return;
      }
      if (!await confirmWorkspaceAction(
        context,
        title: 'Change this role?',
        message: 'Changes affect every member assigned to this role. Disabling a role requires its members to be reassigned first.',
        action: 'Save role',
      )) {
        return;
      }
      if (!mounted) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_create) {
        await widget.api.post('/roles', body: patch);
      } else {
        await widget.api.patch('/roles/${widget.roleId}', body: patch);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final available = _permissions.map((item) => textOf(item['code'])).toSet();
    final locked = _selected.difference(available);
    final term = _search.text.trim().toLowerCase();
    final choices = _permissions
        .where(
          (item) => '${item['code']} ${item['description']}'
              .toLowerCase()
              .contains(term),
        )
        .toList();
    return Scaffold(
      appBar: AppBar(title: Text(_create ? 'Create role' : 'Role details')),
      body: SafeArea(
        top: false,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _role == null
            ? WorkspaceBody(
                children: [
                  WorkspaceNotice(
                    _error ?? 'Could not load this role.',
                    error: true,
                    onRetry: _load,
                  ),
                ],
              )
            : Form(
                key: _form,
                child: WorkspaceBody(
                  children: [
                    if (_error != null) WorkspaceNotice(_error!, error: true),
                    if (_system)
                      const WorkspaceNotice(
                        'This built-in role is maintained by the platform. Its capabilities are shown below; create a custom role for different access.',
                      ),
                    if (_held && !_system)
                      const WorkspaceNotice(
                        'You hold this role. Another administrator must change its permissions or disable it. You may update its name.',
                      ),
                    WorkspaceCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            'Role identity',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 20),
                          if (_editable)
                            TextFormField(
                              controller: _name,
                              readOnly: _busy,
                              validator: requiredText,
                              maxLength: 255,
                              decoration: const InputDecoration(
                                labelText: 'Role name',
                              ),
                            )
                          else
                            WorkspaceField('Name', _name.text),
                          const SizedBox(height: 12),
                          if (_create)
                            TextFormField(
                              controller: _code,
                              readOnly: _busy,
                              validator: requiredText,
                              maxLength: 64,
                              decoration: const InputDecoration(
                                labelText: 'Role code',
                                helperText:
                                    'A unique, permanent workspace identifier.',
                              ),
                            )
                          else
                            WorkspaceField('Code', _code.text),
                          if (!_create && _editable && !_held)
                            DropdownButtonFormField<String>(
                              initialValue: _status,
                              decoration: const InputDecoration(
                                labelText: 'Role status',
                              ),
                              items: const [
                                DropdownMenuItem(
                                  value: 'active',
                                  child: Text('Active'),
                                ),
                                DropdownMenuItem(
                                  value: 'inactive',
                                  child: Text('Inactive'),
                                ),
                              ],
                              onChanged: _busy
                                  ? null
                                  : (value) => setState(() => _status = value!),
                            )
                          else if (!_create)
                            Align(
                              alignment: Alignment.centerLeft,
                              child: WorkspaceStatus(_status),
                            ),
                        ],
                      ),
                    ),
                    WorkspaceCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            'Permissions · ${_selected.length} selected',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            _editable && !_held
                                ? 'Choose only the workspace capabilities this role needs.'
                                : 'The capabilities granted by this role.',
                            style: TextStyle(
                              color: context.colors.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 16),
                          if (_editable && !_held) ...[
                            TextField(
                              controller: _search,
                              onChanged: (_) => setState(() {}),
                              decoration: const InputDecoration(
                                labelText: 'Find a permission',
                                prefixIcon: Icon(Icons.search_rounded),
                              ),
                            ),
                            const SizedBox(height: 12),
                            if (choices.isEmpty)
                              const Padding(
                                padding: EdgeInsets.all(12),
                                child: Text(
                                  'No matching assignable permissions.',
                                ),
                              ),
                            ...choices.map(
                              (permission) => CheckboxListTile(
                                contentPadding: EdgeInsets.zero,
                                controlAffinity:
                                    ListTileControlAffinity.leading,
                                title: Text(textOf(permission['description'])),
                                subtitle: Text(
                                  textOf(permission['code']),
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                value: _selected.contains(permission['code']),
                                onChanged: _busy
                                    ? null
                                    : (selected) => setState(() {
                                        if (selected == true) {
                                          _selected.add(
                                            textOf(permission['code']),
                                          );
                                        } else {
                                          _selected.remove(permission['code']);
                                        }
                                      }),
                              ),
                            ),
                            if (locked.isNotEmpty) ...[
                              const SizedBox(height: 12),
                              const Text(
                                'These existing permissions are outside your grant authority. Remove them before changing the permission set, or ask an administrator who holds them.',
                              ),
                              ...locked.map(
                                (code) => ListTile(
                                  contentPadding: EdgeInsets.zero,
                                  leading: const Icon(
                                    Icons.lock_outline_rounded,
                                  ),
                                  title: Text(friendlyLabel(code)),
                                  subtitle: Text(code),
                                  trailing: IconButton(
                                    tooltip: 'Remove $code',
                                    onPressed: _busy
                                        ? null
                                        : () => setState(
                                            () => _selected.remove(code),
                                          ),
                                    icon: const Icon(
                                      Icons.remove_circle_outline_rounded,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ] else
                            ..._selected.map(
                              (code) => Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 10,
                                ),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Icon(
                                      Icons.check_circle_outline_rounded,
                                      color: context.colors.brand,
                                      size: 22,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(child: Text(code)),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (_editable)
                      WorkspaceSaveButton(
                        busy: _busy,
                        onPressed: _save,
                        label: _create ? 'Create role' : 'Save role',
                      ),
                  ],
                ),
              ),
      ),
    );
  }
}

class WorkspaceGroupsPage extends StatelessWidget {
  const WorkspaceGroupsPage({
    super.key,
    required this.api,
    required this.session,
    required this.onSessionChanged,
  });
  final ApiClient api;
  final AuthSession session;
  final Future<void> Function() onSessionChanged;
  @override
  Widget build(BuildContext context) => WorkspacePagedDirectory(
    api: api,
    path: '/groups',
    title: 'Groups',
    description: 'Keep people together and manage shared collection access through groups.',
    createLabel: 'Create group',
    onChanged: onSessionChanged,
    onCreate: session.can('group.manage')
        ? () => Navigator.of(context).push<bool>(
            MaterialPageRoute(
              builder: (_) => _GroupPage(api: api, session: session),
            ),
          )
        : null,
    onOpen: (row) => Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) =>
            _GroupPage(api: api, session: session, groupId: textOf(row['id'])),
      ),
    ),
    rowBuilder: (context, row, onTap) => WorkspaceDirectoryTile(
      title: directoryName(row),
      subtitle:
          '${row['member_count'] ?? 0} members${textOf(row['description']).isEmpty ? '' : '\n${row['description']}'}',
      icon: Icons.groups_outlined,
      status: textOf(row['status']),
      onTap: onTap,
    ),
  );
}

class _GroupPage extends StatefulWidget {
  const _GroupPage({required this.api, required this.session, this.groupId});
  final ApiClient api;
  final AuthSession session;
  final String? groupId;
  @override
  State<_GroupPage> createState() => _GroupPageState();
}

class _GroupPageState extends State<_GroupPage> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController(),
      _code = TextEditingController(),
      _description = TextEditingController();
  JsonMap? _group;
  bool _loading = true, _busy = false;
  String _status = 'active';
  String? _error;
  bool get _create => widget.groupId == null;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _code.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final group = _create
          ? <String, dynamic>{}
          : await widget.api.get('/groups/${widget.groupId}');
      if (!mounted) return;
      setState(() {
        _group = group;
        _name.text = textOf(group['display_name']);
        _code.text = textOf(group['code']);
        _description.text = textOf(group['description']);
        _status = textOf(group['status'], 'active');
        _loading = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate() || _busy) return;
    final body = <String, dynamic>{
      'display_name': _name.text.trim(),
      if (_create) 'code': _code.text.trim(),
      'description': _description.text.trim().isEmpty
          ? null
          : _description.text.trim(),
      if (!_create) 'status': _status,
    };
    if (!_create && _status != _group!['status']) {
      final confirmed = await confirmWorkspaceAction(
        context,
        title: 'Change group status?',
        message: 'Inactive groups no longer provide their members with group-based access.',
        action: 'Change status',
      );
      if (!confirmed || !mounted) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_create) {
        await widget.api.post('/groups', body: body);
      } else {
        await widget.api.patch('/groups/${widget.groupId}', body: body);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _delete() async {
    if (!await confirmWorkspaceAction(
      context,
      title: 'Delete this group?',
      message:
          'Members lose all access granted through ${directoryName(_group!)}. Member accounts are not deleted. This cannot be undone.',
      action: 'Delete group',
      destructive: true,
    )) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.delete('/groups/${widget.groupId}');
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _members() async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => _GroupMembersPage(
          api: widget.api,
          groupId: widget.groupId!,
          title: directoryName(_group!),
          canReadDirectory: widget.session.can('user.manage'),
        ),
      ),
    );
    if (mounted && changed == true) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(_create ? 'Create group' : 'Group details')),
    body: SafeArea(
      top: false,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _group == null
          ? WorkspaceBody(
              children: [
                WorkspaceNotice(
                  _error ?? 'Could not load this group.',
                  error: true,
                  onRetry: _load,
                ),
              ],
            )
          : Form(
              key: _form,
              child: WorkspaceBody(
                children: [
                  if (_error != null) WorkspaceNotice(_error!, error: true),
                  WorkspaceCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Group identity',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 20),
                        TextFormField(
                          controller: _name,
                          validator: requiredText,
                          readOnly: _busy,
                          maxLength: 255,
                          decoration: const InputDecoration(
                            labelText: 'Group name',
                          ),
                        ),
                        const SizedBox(height: 12),
                        if (_create)
                          TextFormField(
                            controller: _code,
                            validator: requiredText,
                            readOnly: _busy,
                            maxLength: 64,
                            decoration: const InputDecoration(
                              labelText: 'Group code',
                              helperText:
                                  'A unique, permanent workspace identifier.',
                            ),
                          )
                        else
                          WorkspaceField('Code', _code.text),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _description,
                          minLines: 2,
                          maxLines: 5,
                          maxLength: 2000,
                          readOnly: _busy,
                          decoration: const InputDecoration(
                            labelText: 'Description',
                            alignLabelWithHint: true,
                          ),
                        ),
                        if (!_create) ...[
                          const SizedBox(height: 12),
                          DropdownButtonFormField<String>(
                            initialValue: _status,
                            decoration: const InputDecoration(
                              labelText: 'Group status',
                            ),
                            items: const [
                              DropdownMenuItem(
                                value: 'active',
                                child: Text('Active'),
                              ),
                              DropdownMenuItem(
                                value: 'inactive',
                                child: Text('Inactive'),
                              ),
                            ],
                            onChanged: _busy
                                ? null
                                : (value) => setState(() => _status = value!),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (!_create)
                    WorkspaceCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            '${_group!['member_count'] ?? 0} members',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 12),
                          if (objectList(_group!['members']).isEmpty)
                            const Text('No members belong to this group yet.'),
                          ...objectList(_group!['members']).map(
                            (member) => ListTile(
                              contentPadding: EdgeInsets.zero,
                              title: Text(directoryName(member)),
                              subtitle: Text(textOf(member['email'])),
                              leading: const Icon(Icons.person_outline_rounded),
                            ),
                          ),
                          OutlinedButton.icon(
                            onPressed: _busy ? null : _members,
                            icon: const Icon(Icons.group_add_outlined),
                            label: const Text('Manage members'),
                          ),
                        ],
                      ),
                    ),
                  WorkspaceSaveButton(
                    busy: _busy,
                    onPressed: _save,
                    label: _create ? 'Create group' : 'Save group',
                  ),
                  if (!_create) ...[
                    const SizedBox(height: 16),
                    TextButton.icon(
                      onPressed: _busy ? null : _delete,
                      style: TextButton.styleFrom(
                        foregroundColor: Theme.of(context).colorScheme.error,
                      ),
                      icon: const Icon(Icons.delete_outline_rounded),
                      label: const Text('Delete group'),
                    ),
                  ],
                ],
              ),
            ),
    ),
  );
}

class _GroupMembersPage extends StatefulWidget {
  const _GroupMembersPage({
    required this.api,
    required this.groupId,
    required this.title,
    required this.canReadDirectory,
  });
  final ApiClient api;
  final String groupId, title;
  final bool canReadDirectory;
  @override
  State<_GroupMembersPage> createState() => _GroupMembersPageState();
}

class _GroupMembersPageState extends State<_GroupMembersPage> {
  final _search = TextEditingController();
  List<JsonMap> _members = [];
  Set<String> _selected = {};
  bool _loading = true, _busy = false, _loaded = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await Future.wait([
        widget.api.get('/groups/${widget.groupId}'),
        widget.canReadDirectory
            ? allDirectoryRows(widget.api, '/users')
            : Future<List<JsonMap>>.value([]),
      ]);
      if (!mounted) return;
      final existing = objectList(objectOf(result[0])['members']);
      final members = objectList(result[1]);
      final ids = members.map((member) => textOf(member['id'])).toSet();
      members.addAll(
        existing.where((member) => !ids.contains(textOf(member['id']))),
      );
      setState(() {
        _members = members;
        _selected = referenceIds(existing);
        _loading = false;
        _loaded = true;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _save() async {
    if (_members.any(
      (member) =>
          _selected.contains(member['id']) &&
          member.containsKey('status') &&
          member['status'] != 'active',
    )) {
      setState(
        () => _error = 'Only active workspace members can be included. Restore suspended access first, or remove those members from this group.',
      );
      return;
    }
    if (!await confirmWorkspaceAction(
      context,
      title: 'Replace group membership?',
      message:
          '${_selected.length} selected members will belong to ${widget.title}. Unselected members lose access provided by this group.',
      action: 'Save members',
    )) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.put(
        '/groups/${widget.groupId}/members',
        body: {'user_ids': _selected.toList()},
      );
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final matching = _members
        .where(
          (member) => '${directoryName(member)} ${member['email']}'
              .toLowerCase()
              .contains(_search.text.trim().toLowerCase()),
        )
        .toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Group members')),
      body: SafeArea(
        top: false,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : !_loaded
            ? WorkspaceBody(
                children: [
                  WorkspaceNotice(
                    _error ?? 'Could not load group members.',
                    error: true,
                    onRetry: _load,
                  ),
                ],
              )
            : WorkspaceBody(
                children: [
                  if (_error != null)
                    WorkspaceNotice(_error!, error: true, onRetry: _load),
                  Text(
                    widget.title,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${_selected.length} selected · Only active workspace members can be added.',
                  ),
                  const SizedBox(height: 20),
                  if (!widget.canReadDirectory)
                    const WorkspaceNotice(
                      'You can remove existing group members. Adding people also requires permission to browse workspace members.',
                    ),
                  TextField(
                    controller: _search,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                      labelText: 'Search members',
                      prefixIcon: Icon(Icons.search_rounded),
                    ),
                  ),
                  const SizedBox(height: 16),
                  if (matching.isEmpty)
                    const WorkspaceEmpty(
                      title: 'No matching members',
                      message: 'Try a different name or email.',
                    ),
                  ...matching.map((member) {
                    final id = textOf(member['id']);
                    final active =
                        !member.containsKey('status') ||
                        member['status'] == 'active';
                    return Card(
                      child: CheckboxListTile(
                        controlAffinity: ListTileControlAffinity.leading,
                        title: Text(directoryName(member)),
                        subtitle: Text(
                          '${textOf(member['email'])}${active ? '' : '\nNot active in this workspace'}',
                        ),
                        value: _selected.contains(id),
                        onChanged: _busy || (!active && !_selected.contains(id))
                            ? null
                            : (value) => setState(() {
                                if (value == true) {
                                  _selected.add(id);
                                } else {
                                  _selected.remove(id);
                                }
                              }),
                      ),
                    );
                  }),
                  const SizedBox(height: 20),
                  WorkspaceSaveButton(
                    busy: _busy,
                    onPressed: _save,
                    label: 'Save members',
                  ),
                ],
              ),
      ),
    );
  }
}
