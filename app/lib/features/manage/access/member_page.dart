import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import '../../auth/session.dart';
import 'access_sheets.dart';

/// One member: their role and groups as rows that open a picker (saved on
/// choosing), and suspension set apart at the bottom.
class MemberPage extends StatefulWidget {
  const MemberPage({super.key, required this.userId});
  final String userId;

  @override
  State<MemberPage> createState() => _MemberPageState();
}

class _MemberPageState extends State<MemberPage> {
  JsonMap? _user;
  List<AccessRole>? _roles;
  Object? _error;
  bool _saving = false;
  bool _started = false;
  late ApiClient _api;
  late AuthSession _session;

  String get _path => '/users/${Uri.encodeComponent(widget.userId)}';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    _api = scope.api;
    _session = scope.session;
    if (!_started) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final results = await Future.wait([
        _api.get(_path),
        if (_session.can('role.manage')) _rolesOrNull(),
      ]);
      if (!mounted) return;
      setState(() {
        _user = results[0] as JsonMap;
        if (results.length > 1) _roles = results[1] as List<AccessRole>?;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  /// The role catalog only enriches the Role row; the page works without it.
  Future<List<AccessRole>?> _rolesOrNull() async {
    try {
      return await loadRoles(_api);
    } catch (_) {
      return null;
    }
  }

  String get _name => personName(_user ?? const {}, 'This member');
  bool get _active => textOf(_user?['status']) == 'active';
  bool get _isSelf => widget.userId == _session.userId;
  List<JsonMap> get _currentRoles => objectList(_user?['roles']);
  List<JsonMap> get _currentGroups => objectList(_user?['groups']);

  String _label(JsonMap value) {
    final name = textOf(value['display_name']).trim();
    return name.isNotEmpty ? name : sentenceCase(textOf(value['code']));
  }

  String get _roleLine {
    final current = _currentRoles;
    if (current.isEmpty) return 'No role';
    if (current.length == 1) {
      final match = _roles?.where(
        (role) => role.id == textOf(current.first['id']),
      );
      if (match != null && match.isNotEmpty) {
        return '${match.first.name} — ${match.first.gist}';
      }
    }
    return current.map(_label).join(', ');
  }

  Future<void> _save(Map<String, Object?> changes, String done) async {
    setState(() => _saving = true);
    try {
      final user = await _api.patch(_path, body: changes);
      if (!mounted) return;
      setState(() => _user = user);
      showToast(context, done);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _changeRole() async {
    var roles = _roles;
    if (roles == null) {
      setState(() => _saving = true);
      try {
        roles = await loadRoles(_api);
        if (!mounted) return;
        setState(() => _roles = roles);
      } catch (error) {
        if (mounted) showError(context, error);
        return;
      } finally {
        if (mounted) setState(() => _saving = false);
      }
    }
    if (!mounted) return;
    final current = _currentRoles.length == 1
        ? textOf(_currentRoles.first['id'])
        : null;
    final chosen = await pickRole(
      context,
      title: 'Role for $_name',
      subtitle: 'Saved as soon as you choose.',
      roles: assignableRoles(roles),
      selectedId: current,
    );
    if (chosen == null || chosen.id == current || !mounted) return;
    await _save({
      'role_ids': [chosen.id],
    }, '$_name is now ${chosen.name}');
  }

  Future<void> _changeGroups() async {
    setState(() => _saving = true);
    List<AccessGroup> groups;
    try {
      groups = (await loadGroups(_api)).where((group) => group.active).toList();
    } catch (error) {
      if (mounted) showError(context, error);
      return;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
    if (!mounted) return;
    if (groups.isEmpty) {
      showToast(context, 'There are no groups yet. Create one under Groups.');
      return;
    }
    final current = {for (final group in _currentGroups) textOf(group['id'])};
    final chosen = await pickGroups(
      context,
      title: 'Groups for $_name',
      groups: groups,
      selected: current,
    );
    if (chosen == null || !mounted) return;
    if (chosen.length == current.length && chosen.containsAll(current)) return;
    await _save({'group_ids': chosen.toList()}, 'Groups saved');
  }

  Future<void> _toggleSuspension() async {
    final suspend = _active;
    final confirmed = await confirmAction(
      context,
      title: suspend ? 'Suspend $_name?' : 'Restore $_name?',
      message: suspend
          ? 'They can no longer open this workspace. Their account, role and groups stay as they are, so you can restore them later.'
          : 'They can open this workspace again with the role and groups they had.',
      confirmLabel: suspend ? 'Suspend member' : 'Restore member',
      destructive: suspend,
    );
    if (!confirmed || !mounted) return;
    await _save({
      'status': suspend ? 'suspended' : 'active',
    }, suspend ? '$_name is suspended' : '$_name is restored');
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final user = _user;
    final Widget body;
    if (user == null) {
      body = _error != null
          ? ErrorView(error: _error!, onRetry: _load)
          : const LoadingView();
    } else {
      final canEdit = !_isSelf && !_saving;
      final canRoles = _session.can('role.manage');
      final canGroups = _session.can('group.manage');
      final email = textOf(user['email']).trim();
      final groups = _currentGroups.map(_label).join(', ');
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 18),
              child: Column(
                children: [
                  PersonAvatar(name: _name, seed: widget.userId, size: 56),
                  const SizedBox(height: 8),
                  Text(
                    _name,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: colors.ink,
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.3,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    [
                      if (email.isNotEmpty && email != _name) email,
                      _active ? 'Active' : 'Suspended',
                    ].join(' · '),
                    textAlign: TextAlign.center,
                    style: TextStyle(color: colors.ink3, fontSize: 13.5),
                  ),
                ],
              ),
            ),
            ListGroup(
              children: [
                ListRow(
                  leading: const ToneTile(
                    tone: Tone.indigo,
                    icon: Icons.shield_outlined,
                    size: TileSize.small,
                  ),
                  title: 'Role',
                  subtitle: _roleLine,
                  maxSubtitleLines: 2,
                  chevron: canRoles && !_isSelf,
                  onTap: canRoles && canEdit ? _changeRole : null,
                ),
                ListRow(
                  leading: const ToneTile(
                    tone: Tone.violet,
                    icon: Icons.group_outlined,
                    size: TileSize.small,
                  ),
                  title: 'Groups',
                  subtitle: groups.isEmpty ? 'Not in a group' : groups,
                  maxSubtitleLines: 2,
                  chevron: canGroups && !_isSelf,
                  onTap: canGroups && canEdit ? _changeGroups : null,
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
              child: Text(
                _isSelf
                    ? 'You can’t change your own access. Ask another administrator.'
                    : 'Changes apply the next time they open BoMesh.',
                style: TextStyle(color: colors.ink3, fontSize: 13, height: 1.4),
              ),
            ),
            if (_saving)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              ),
            if (!_isSelf) ...[
              const SizedBox(height: 28),
              FilledButton(
                style: _active
                    ? dangerButtonStyle(context)
                    : secondaryButtonStyle(context),
                onPressed: _saving ? null : _toggleSuspension,
                child: Text(_active ? 'Suspend member' : 'Restore member'),
              ),
            ],
          ],
        ),
      );
    }
    return Scaffold(
      backgroundColor: colors.paper,
      appBar: const AppHeader(paper: true),
      body: body,
    );
  }
}
