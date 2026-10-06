import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';

/// Manage → Settings: only what the workspace contract supports. The name is
/// editable with tenant.manage; code and status are read-only facts. The save
/// bar appears after an edit.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _name = TextEditingController();
  ApiClient? _api;
  String _workspaceId = '';
  JsonMap? _workspace;
  String _savedName = '';
  Object? _error;
  bool _saving = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    if (!identical(scope.api, _api) ||
        scope.session.activeWorkspaceId != _workspaceId) {
      _api = scope.api;
      _workspaceId = scope.session.activeWorkspaceId;
      _workspace = null;
      _error = null;
      _load();
    }
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  String get _path => '/workspaces/${Uri.encodeComponent(_workspaceId)}';

  void _retry() {
    setState(() => _error = null);
    _load();
  }

  Future<void> _load() async {
    try {
      final workspace = await _api!.get(_path);
      if (!mounted) return;
      setState(() {
        _workspace = workspace;
        _savedName = textOf(workspace['name']);
        _name.text = _savedName;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  bool get _edited => _name.text.trim() != _savedName;

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    final scope = WorkspaceScope.of(context);
    setState(() => _saving = true);
    try {
      final workspace = await _api!.patch(_path, body: {'name': name});
      if (!mounted) return;
      setState(() {
        _workspace = workspace;
        _savedName = textOf(workspace['name'], name);
        _name.text = _savedName;
      });
      showToast(context, 'Saved');
      await scope.auth.refresh();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final canEdit = WorkspaceScope.of(context).session.can('tenant.manage');
    final workspace = _workspace;
    return Scaffold(
      backgroundColor: colors.paper,
      appBar: const AppHeader(title: 'Settings', paper: true),
      body: workspace == null
          ? (_error != null
                ? ErrorView(error: _error!, onRetry: _retry)
                : const LoadingView())
          : ListView(
              padding: kPagePadding,
              children: [
                _FormGroup(
                  label: 'Workspace name',
                  helper: 'Shown in the workspace switcher and to members.',
                  child: canEdit
                      ? TextField(
                          controller: _name,
                          textCapitalization: TextCapitalization.words,
                          textInputAction: TextInputAction.done,
                          maxLength: 255,
                          buildCounter: (
                            _, {
                            required currentLength,
                            required isFocused,
                            maxLength,
                          }) => null,
                          onChanged: (_) => setState(() {}),
                          onSubmitted: (_) {
                            if (_edited) _save();
                          },
                        )
                      : _ReadOnlyField(child: Text(_savedName)),
                ),
                _FormGroup(
                  label: 'Code',
                  helper: 'Set when the workspace was created.',
                  child: _ReadOnlyField(child: Text(textOf(workspace['code']))),
                ),
                _FormGroup(
                  label: 'Status',
                  helper: 'Managed by the platform team.',
                  child: _ReadOnlyField(
                    child: _statusRow(textOf(workspace['status'])),
                  ),
                ),
              ],
            ),
      bottomNavigationBar: canEdit && workspace != null && _edited
          ? StickyActionBar(
              note: _name.text.trim().isEmpty
                  ? 'The name can’t be empty'
                  : 'Edited · not saved',
              children: [
                FilledButton(
                  onPressed: _saving || _name.text.trim().isEmpty
                      ? null
                      : _save,
                  child: Text(_saving ? 'Saving…' : 'Save'),
                ),
              ],
            )
          : null,
    );
  }

  Widget _statusRow(String status) {
    final (words, pill) = switch (status) {
      'inactive' => (
        'Not available',
        const StatusPill(label: 'Inactive', tone: StatusTone.neutral),
      ),
      'suspended' => (
        'Not available',
        const StatusPill(label: 'Suspended', tone: StatusTone.danger),
      ),
      _ => (
        'Available',
        const StatusPill(label: 'Active', tone: StatusTone.success),
      ),
    };
    return Row(
      children: [
        Expanded(child: Text(words)),
        pill,
      ],
    );
  }
}

class _FormGroup extends StatelessWidget {
  const _FormGroup({
    required this.label,
    required this.helper,
    required this.child,
  });
  final String label, helper;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
            child: Text(
              label,
              style: TextStyle(
                color: colors.ink3,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          child,
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
            child: Text(
              helper,
              style: TextStyle(color: colors.ink3, fontSize: 12.5, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

/// A fact that looks read-only: the subtle surface, no border emphasis.
class _ReadOnlyField extends StatelessWidget {
  const _ReadOnlyField({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      constraints: const BoxConstraints(minHeight: 48),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: colors.subtle,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: colors.line),
      ),
      alignment: Alignment.centerLeft,
      child: DefaultTextStyle.merge(
        style: TextStyle(color: colors.ink2, fontSize: 16),
        child: child,
      ),
    );
  }
}
