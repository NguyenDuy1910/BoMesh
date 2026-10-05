import 'package:flutter/material.dart';

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

/// Who is in a group.
Future<void> showGroupSheet(
  BuildContext context, {
  required ApiClient api,
  required AccessGroup group,
}) => showAppSheet<void>(
  context,
  title: group.name,
  subtitle: group.description.isEmpty
      ? countOf(group.memberCount, 'member')
      : group.description,
  builder: (_) => _GroupMembers(api: api, group: group),
);

class _GroupMembers extends StatefulWidget {
  const _GroupMembers({required this.api, required this.group});
  final ApiClient api;
  final AccessGroup group;

  @override
  State<_GroupMembers> createState() => _GroupMembersState();
}

class _GroupMembersState extends State<_GroupMembers> {
  late Future<AccessGroup> _group = _load();

  Future<AccessGroup> _load() async => AccessGroup.fromJson(
    await widget.api.get('/groups/${Uri.encodeComponent(widget.group.id)}'),
  );

  @override
  Widget build(BuildContext context) => FutureBuilder<AccessGroup>(
    future: _group,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return ErrorView(
          error: snapshot.error!,
          onRetry: () => setState(() => _group = _load()),
        );
      }
      final group = snapshot.data;
      if (group == null) return const LoadingView();
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (group.members.isEmpty)
            const InlineNotice(text: 'No one is in this group yet.')
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final member in group.members)
                    ListRow(
                      leading: PersonAvatar(
                        name: personName(member),
                        seed: textOf(member['id']),
                      ),
                      title: personName(member),
                      subtitle: textOf(member['email']),
                    ),
                ],
              ),
            ),
          const SizedBox(height: 10),
          const InlineNotice(
            text: 'Add or remove someone from a group on their member page.',
          ),
        ],
      );
    },
  );
}

/// What a role is; capabilities are edited on the web.
Future<void> showRoleSheet(
  BuildContext context, {
  required ApiClient api,
  required AccessRole role,
}) => showAppSheet<void>(
  context,
  title: role.name,
  subtitle:
      '${sentenceCase(role.gist)} · ${countOf(role.memberCount, 'member')}',
  builder: (_) => _RoleCapabilities(api: api, role: role),
);

class _RoleCapabilities extends StatefulWidget {
  const _RoleCapabilities({required this.api, required this.role});
  final ApiClient api;
  final AccessRole role;

  @override
  State<_RoleCapabilities> createState() => _RoleCapabilitiesState();
}

class _RoleCapabilitiesState extends State<_RoleCapabilities> {
  /// Permission code → its plain description, from the catalog.
  late Future<Map<String, String>> _catalog = _load();

  Future<Map<String, String>> _load() async {
    final body = await widget.api.get('/permissions');
    return {
      for (final item in objectList(body['items']))
        textOf(item['code']): textOf(item['description']),
    };
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final codes = widget.role.permissionCodes;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (codes.isNotEmpty)
          Flexible(
            child: FutureBuilder<Map<String, String>>(
              future: _catalog,
              builder: (context, snapshot) {
                if (snapshot.hasError) {
                  return InlineNotice(
                    text: 'What this role can do could not be loaded.',
                    tone: StatusTone.warning,
                    actionLabel: 'Try again',
                    onAction: () => setState(() => _catalog = _load()),
                  );
                }
                final catalog = snapshot.data;
                if (catalog == null) return const LoadingView();
                final lines = [
                  for (final code in codes)
                    if ((catalog[code] ?? '').isNotEmpty) catalog[code]!,
                ];
                return ListView(
                  shrinkWrap: true,
                  children: [
                    for (final line in lines)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 6,
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(
                              Icons.check_rounded,
                              size: 18,
                              color: colors.success,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                line,
                                style: TextStyle(
                                  color: colors.ink2,
                                  fontSize: 14.5,
                                  height: 1.4,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        const SizedBox(height: 12),
        const InlineNotice(
          icon: Icons.computer_rounded,
          text: 'Edit what a role can do on the web.',
        ),
      ],
    );
  }
}
