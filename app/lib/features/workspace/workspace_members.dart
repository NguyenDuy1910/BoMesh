import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../auth/session.dart';
import 'workspace_widgets.dart';

class WorkspaceMembersPage extends StatelessWidget {
  const WorkspaceMembersPage({
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
    path: '/users',
    title: 'Members',
    description:
        'Manage who belongs to ${session.workspaceName}. Account identities stay separate from workspace access.',
    createLabel: 'Add existing account',
    onCreate: session.can('user.manage')
        ? () => Navigator.of(context).push<bool>(
            MaterialPageRoute(
              builder: (_) => _MemberPage(api: api, session: session),
            ),
          )
        : null,
    onOpen: (member) => Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => _MemberPage(
          api: api,
          session: session,
          memberId: textOf(member['id']),
        ),
      ),
    ),
    onChanged: onSessionChanged,
    rowBuilder: (context, member, onTap) => WorkspaceDirectoryTile(
      title: directoryName(member),
      subtitle: [
        textOf(member['email']),
        objectList(member['roles']).map(directoryName).join(', '),
        objectList(member['groups']).map(directoryName).join(', '),
      ].where((text) => text.isNotEmpty).join('\n'),
      icon: Icons.person_outline_rounded,
      status: textOf(member['status']),
      onTap: onTap,
    ),
  );
}

class _MemberPage extends StatefulWidget {
  const _MemberPage({required this.api, required this.session, this.memberId});
  final ApiClient api;
  final AuthSession session;
  final String? memberId;
  @override
  State<_MemberPage> createState() => _MemberPageState();
}

class _MemberPageState extends State<_MemberPage> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _name = TextEditingController();
  Timer? _lookupTimer;
  List<JsonMap> _roles = [], _groups = [];
  JsonMap? _member, _account;
  Set<String> _roleIds = {}, _groupIds = {};
  bool _loading = true, _busy = false, _checking = false, _lookedUp = false;
  String? _error, _lookupError;
  int _lookupRequest = 0;
  bool get _adding => widget.memberId == null;
  bool get _self => widget.memberId == widget.session.userId;
  bool get _manage => widget.session.can('user.manage');
  bool get _rolesAvailable => widget.session.can('role.manage');
  bool get _groupsAvailable => widget.session.can('group.manage');

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _lookupTimer?.cancel();
    _email.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await Future.wait([
        _adding
            ? Future<JsonMap>.value({})
            : widget.api.get('/users/${widget.memberId}'),
        _rolesAvailable
            ? allDirectoryRows(widget.api, '/roles')
            : Future<List<JsonMap>>.value([]),
        _groupsAvailable
            ? allDirectoryRows(widget.api, '/groups')
            : Future<List<JsonMap>>.value([]),
      ]);
      if (!mounted) return;
      final member = objectOf(result[0]);
      setState(() {
        _member = member;
        _name.text = textOf(member['display_name']);
        _email.text = textOf(member['email']);
        _roleIds = referenceIds(member['roles']);
        _groupIds = referenceIds(member['groups']);
        _roles = objectList(result[1])
            .where(
              (role) =>
                  role['status'] == 'active' &&
                  stringSet(role['permission_codes'])
                      .every(widget.session.permissions.contains),
            )
            .toList();
        _groups = objectList(result[2])
            .where((group) => group['status'] == 'active')
            .toList();
        _loading = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  void _emailChanged(String _) {
    _lookupTimer?.cancel();
    ++_lookupRequest;
    setState(() {
      _account = null;
      _lookedUp = false;
      _lookupError = null;
      _checking = false;
    });
    final email = _email.text.trim();
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)) return;
    setState(() => _checking = true);
    _lookupTimer = Timer(const Duration(milliseconds: 350), _lookup);
  }

  Future<void> _lookup() async {
    final request = ++_lookupRequest;
    final email = _email.text.trim().toLowerCase();
    setState(() {
      _checking = true;
      _lookupError = null;
    });
    try {
      final response = await widget.api.get(
        '/accounts',
        query: {'email': email},
      );
      if (!mounted || request != _lookupRequest) return;
      final accounts = objectList(response['items']);
      setState(() {
        _account = accounts.isEmpty ? null : accounts.first;
        _lookedUp = true;
        _checking = false;
      });
    } catch (error) {
      if (mounted && request == _lookupRequest) {
        setState(() {
          _lookupError = error.toString();
          _checking = false;
        });
      }
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate() || _busy) return;
    if (_adding &&
        (_checking ||
            _account == null ||
            _account!['status'] != 'active' ||
            _account!['workspace_membership'] != 'none')) {
      setState(
        () => _error =
            'Look up an active account that is not already in this workspace.',
      );
      return;
    }
    final patch = <String, dynamic>{};
    if (_adding) {
      patch.addAll({
        'email': _account!['email'],
        'role_ids': _roleIds.toList(),
        'group_ids': _groupIds.toList(),
      });
    } else {
      if (_name.text.trim() != textOf(_member!['display_name'])) {
        patch['display_name'] = _name.text.trim();
      }
      if (!_self &&
          _rolesAvailable &&
          !setEquals(_roleIds, referenceIds(_member!['roles']))) {
        patch['role_ids'] = _roleIds.toList();
      }
      if (!_self &&
          _groupsAvailable &&
          !setEquals(_groupIds, referenceIds(_member!['groups']))) {
        patch['group_ids'] = _groupIds.toList();
      }
      if (patch.isEmpty) {
        Navigator.pop(context, false);
        return;
      }
    }
    if (patch.containsKey('role_ids') || patch.containsKey('group_ids')) {
      final confirmed = await confirmWorkspaceAction(
        context,
        title: _adding ? 'Add this member?' : 'Update workspace access?',
        message: _adding
            ? '${directoryName(_account!)} will join ${widget.session.workspaceName} with the selected access.'
            : 'The selected roles and groups will replace this member’s current workspace access.',
        action: _adding ? 'Add member' : 'Update access',
      );
      if (!confirmed || !mounted) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_adding) {
        await widget.api.post('/users', body: patch);
      } else {
        await widget.api.patch('/users/${widget.memberId}', body: patch);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _busy = false;
        });
      }
    }
  }

  Future<void> _changeStatus() async {
    final active = _member!['status'] == 'active';
    final confirmed = await confirmWorkspaceAction(
      context,
      title: active ? 'Suspend workspace access?' : 'Restore workspace access?',
      message: active
          ? 'This removes ${directoryName(_member!)}’s access to this workspace. Their account and other workspaces are not changed.'
          : 'This restores access with the roles and groups already assigned to this member.',
      action: active ? 'Suspend access' : 'Restore access',
      destructive: active,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.patch(
        '/users/${widget.memberId}',
        body: {'status': active ? 'suspended' : 'active'},
      );
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _busy = false;
        });
      }
    }
  }

  Widget _choices(
    String label,
    List<JsonMap> rows,
    Set<String> selected,
    Object? current,
  ) {
    final known = rows.map((row) => textOf(row['id'])).toSet();
    final retained = objectList(current)
        .where((row) => !known.contains(textOf(row['id'])))
        .toList();
    return WorkspaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(label, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (rows.isEmpty)
            Text('No assignable ${label.toLowerCase()} are available.'),
          ...retained.map(
            (row) => ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(directoryName(row)),
              subtitle: Text(
                selected.contains(textOf(row['id']))
                    ? 'Current assignment · outside your grant authority'
                    : 'Removed · cannot be reassigned by you',
              ),
              leading: const Icon(Icons.lock_outline_rounded),
              trailing: selected.contains(textOf(row['id']))
                  ? IconButton(
                      tooltip: 'Remove ${directoryName(row)} assignment',
                      onPressed: _busy
                          ? null
                          : () => setState(
                              () => selected.remove(textOf(row['id'])),
                            ),
                      icon: const Icon(Icons.remove_circle_outline_rounded),
                    )
                  : null,
            ),
          ),
          ...rows.map(
            (row) => CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(directoryName(row)),
              subtitle: row.containsKey('permission_codes')
                  ? Text(
                      '${stringSet(row['permission_codes']).length} permissions',
                    )
                  : null,
              value: selected.contains(textOf(row['id'])),
              onChanged: _busy
                  ? null
                  : (value) => setState(() {
                      if (value == true) {
                        selected.add(textOf(row['id']));
                      } else {
                        selected.remove(textOf(row['id']));
                      }
                    }),
            ),
          ),
          if (label == 'Workspace roles')
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'No roles are selected automatically. Only permissions you can grant are offered.',
              ),
            ),
        ],
      ),
    );
  }

  Widget _accountResult() {
    if (_checking) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: LinearProgressIndicator(),
      );
    }
    if (_lookupError != null) {
      return WorkspaceNotice(_lookupError!, error: true, onRetry: _lookup);
    }
    if (!_lookedUp) {
      return const WorkspaceNotice(
        'Enter the full email they use to sign in. Members must already have a BoThesis account.',
      );
    }
    if (_account == null) {
      return const WorkspaceNotice(
        'No account uses this email. Ask them to create a BoThesis account, then look them up again.',
      );
    }
    final standing = textOf(_account!['workspace_membership']);
    final disabled = _account!['status'] != 'active';
    return WorkspaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            directoryName(_account!),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 6),
          Text(textOf(_account!['email'])),
          const SizedBox(height: 12),
          Text(
            disabled
                ? 'This account is disabled. Workspace administrators cannot reactivate it.'
                : standing == 'active'
                ? 'Already a member of this workspace.'
                : standing == 'suspended'
                ? 'Access is suspended here. Restore access from member details.'
                : 'Account found. Choose the access to grant below.',
          ),
          if (!disabled && standing != 'none')
            TextButton.icon(
              onPressed: _busy
                  ? null
                  : () async {
                      final changed = await Navigator.of(context).push<bool>(
                        MaterialPageRoute(
                          builder: (_) => _MemberPage(
                            api: widget.api,
                            session: widget.session,
                            memberId: textOf(_account!['id']),
                          ),
                        ),
                      );
                      if (mounted && changed == true) {
                        Navigator.pop(context, true);
                      }
                    },
              icon: const Icon(Icons.person_outline_rounded),
              label: const Text('Open member details'),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(_adding ? 'Add member' : 'Member details')),
    body: SafeArea(
      top: false,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _member == null
          ? WorkspaceBody(
              children: [
                WorkspaceNotice(
                  _error ?? 'Could not load this member.',
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
                          _adding
                              ? 'Find an existing account'
                              : directoryName(_member!),
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 20),
                        if (_adding)
                          TextFormField(
                            controller: _email,
                            keyboardType: TextInputType.emailAddress,
                            autocorrect: false,
                            textCapitalization: TextCapitalization.none,
                            decoration: const InputDecoration(
                              labelText: 'Email address',
                              hintText: 'name@company.com',
                            ),
                            onChanged: _emailChanged,
                            readOnly: _busy,
                            validator: (value) =>
                                RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                                    .hasMatch(value?.trim() ?? '')
                                ? null
                                : 'Enter a complete email address.',
                          )
                        else ...[
                          WorkspaceField('Email', textOf(_member!['email'])),
                          TextFormField(
                            controller: _name,
                            readOnly: !_manage || _busy,
                            maxLength: 255,
                            validator: (value) =>
                                textOf(_member!['display_name']).isNotEmpty
                                ? requiredText(value)
                                : null,
                            decoration: const InputDecoration(
                              labelText: 'Display name',
                            ),
                          ),
                          const SizedBox(height: 12),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: WorkspaceStatus(textOf(_member!['status'])),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (_adding) _accountResult(),
                  if (_self)
                    const WorkspaceNotice(
                      'Another workspace administrator must change your roles, groups, or access status.',
                    ),
                  if (!_adding && _self) ...[
                    WorkspaceField(
                      'Workspace roles',
                      objectList(_member!['roles'])
                          .map(directoryName)
                          .join(', '),
                    ),
                    WorkspaceField(
                      'Groups',
                      objectList(_member!['groups'])
                          .map(directoryName)
                          .join(', '),
                    ),
                  ],
                  if (!_self &&
                      (!_adding ||
                          (_account?['status'] == 'active' &&
                              _account?['workspace_membership'] ==
                                  'none'))) ...[
                    if (_rolesAvailable)
                      _choices(
                        'Workspace roles',
                        _roles,
                        _roleIds,
                        _member!['roles'],
                      )
                    else
                      WorkspaceField(
                        'Workspace roles',
                        objectList(_member!['roles'])
                            .map(directoryName)
                            .join(', '),
                      ),
                    if (_groupsAvailable)
                      _choices('Groups', _groups, _groupIds, _member!['groups'])
                    else if (!_adding)
                      WorkspaceField(
                        'Groups',
                        objectList(_member!['groups'])
                            .map(directoryName)
                            .join(', '),
                      ),
                  ],
                  if (_manage)
                    WorkspaceSaveButton(
                      busy: _busy,
                      onPressed: _save,
                      label: _adding ? 'Add to workspace' : 'Save changes',
                    ),
                  if (!_adding &&
                      !_self &&
                      _manage &&
                      _member!['status'] != 'inactive') ...[
                    const SizedBox(height: 16),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _changeStatus,
                      icon: Icon(
                        _member!['status'] == 'active'
                            ? Icons.block_rounded
                            : Icons.restore_rounded,
                      ),
                      label: Text(
                        _member!['status'] == 'active'
                            ? 'Suspend access'
                            : 'Restore access',
                      ),
                    ),
                  ],
                  if (!_adding && _member!['status'] == 'inactive')
                    const Padding(
                      padding: EdgeInsets.only(top: 16),
                      child: WorkspaceNotice(
                        'This account is disabled at platform level. Workspace changes cannot reactivate the account.',
                      ),
                    ),
                ],
              ),
            ),
    ),
  );
}
