import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'workspace_widgets.dart';

class WorkspaceApprovalsPage extends StatelessWidget {
  const WorkspaceApprovalsPage({
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
    path: '/approval-requests',
    title: 'Approvals',
    searchable: false,
    description: 'Follow your requests and review collection access or connector requests within your permissions.',
    onChanged: onSessionChanged,
    onOpen: (row) => Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => _ApprovalPage(
          api: api,
          session: session,
          requestId: textOf(row['id']),
        ),
      ),
    ),
    rowBuilder: (context, row, onTap) => WorkspaceDirectoryTile(
      title: row['request_type'] == 'resource_access'
          ? 'Collection access request'
          : 'Connector approval request',
      subtitle:
          '${directoryName(objectOf(row['requester']))}\n${recordedAt(row['created_at'])}',
      status: textOf(row['status']),
      icon: Icons.fact_check_outlined,
      onTap: onTap,
    ),
  );
}

class _ApprovalPage extends StatefulWidget {
  const _ApprovalPage({
    required this.api,
    required this.session,
    required this.requestId,
  });
  final ApiClient api;
  final AuthSession session;
  final String requestId;
  @override
  State<_ApprovalPage> createState() => _ApprovalPageState();
}

class _ApprovalPageState extends State<_ApprovalPage> {
  final _note = TextEditingController();
  JsonMap? _request;
  bool _loading = true, _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final request = await widget.api.get(
        '/approval-requests/${widget.requestId}',
      );
      if (mounted) {
        setState(() {
          _request = request;
          _loading = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _decide(String status) async {
    final action = status == 'approved'
        ? 'Approve request'
        : status == 'denied'
        ? 'Deny request'
        : 'Cancel request';
    final access = _request!['request_type'] == 'resource_access';
    final explanation = status == 'approved'
        ? access
              ? 'This grants the exact collection role requested. Review the requester and collection before continuing.'
              : 'This records governance approval only. It does not install a connector or create a connection.'
        : 'This closes the pending request without granting access. The decision is recorded in the audit trail.';
    if (!await confirmWorkspaceAction(
      context,
      title: '$action?',
      message: explanation,
      action: action,
      destructive: status != 'approved',
    )) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.patch(
        '/approval-requests/${widget.requestId}',
        body: {
          'status': status,
          if (_note.text.trim().isNotEmpty) 'decision_note': _note.text.trim(),
        },
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
    final resourceAccess = _request?['request_type'] == 'resource_access';
    final canReview = widget.session.can(
      resourceAccess ? 'access.manage' : 'source.manage',
    );
    final pending = _request?['status'] == 'pending';
    final canCancel =
        canReview ||
        objectOf(_request?['requester'])['id'] == widget.session.userId;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Request details'),
        actions: [
          IconButton(
            tooltip: 'Refresh request',
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _request == null
            ? WorkspaceBody(
                children: [
                  WorkspaceNotice(
                    _error ?? 'Could not load this request.',
                    error: true,
                    onRetry: _load,
                  ),
                ],
              )
            : WorkspaceBody(
                children: [
                  if (_error != null)
                    WorkspaceNotice(_error!, error: true, onRetry: _load),
                  WorkspaceCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          resourceAccess
                              ? 'Collection access'
                              : 'Connector approval',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 12),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: WorkspaceStatus(textOf(_request!['status'])),
                        ),
                        const SizedBox(height: 24),
                        WorkspaceField(
                          'Requested by',
                          directoryName(objectOf(_request!['requester'])),
                        ),
                        WorkspaceField(
                          'Email',
                          textOf(objectOf(_request!['requester'])['email']),
                        ),
                        WorkspaceField(
                          resourceAccess ? 'Collection ID' : 'Connector',
                          textOf(_request!['target_id']),
                        ),
                        if (_request!['requested_role'] != null)
                          WorkspaceField(
                            'Requested access',
                            directoryName(
                              objectOf(_request!['requested_role']),
                            ),
                          ),
                        WorkspaceField(
                          'Reason',
                          textOf(_request!['reason'], 'No reason supplied'),
                        ),
                        WorkspaceField(
                          'Submitted',
                          recordedAt(_request!['created_at']),
                        ),
                        WorkspaceField('Request ID', widget.requestId),
                        if (objectOf(_request!['details']).isNotEmpty)
                          WorkspaceJsonDetails(objectOf(_request!['details'])),
                      ],
                    ),
                  ),
                  if (!resourceAccess)
                    const WorkspaceNotice(
                      'Connector approval is a governance decision. Connection setup still requires a supported connector and valid credentials.',
                    ),
                  if (!pending)
                    WorkspaceCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            'Decision',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 20),
                          WorkspaceField(
                            'Note',
                            textOf(
                              _request!['decision_note'],
                              'No decision note',
                            ),
                          ),
                          WorkspaceField(
                            'Recorded',
                            recordedAt(_request!['decided_at']),
                          ),
                          if (_request!['decided_by_user_id'] != null)
                            WorkspaceField(
                              'Reviewer ID',
                              textOf(_request!['decided_by_user_id']),
                            ),
                        ],
                      ),
                    ),
                  if (pending && (canReview || canCancel)) ...[
                    WorkspaceCard(
                      child: TextField(
                        controller: _note,
                        maxLength: 4000,
                        minLines: 3,
                        maxLines: 6,
                        readOnly: _busy,
                        decoration: const InputDecoration(
                          labelText: 'Decision note (optional)',
                          alignLabelWithHint: true,
                          helperText: 'Explain the decision for the requester and audit trail.',
                        ),
                      ),
                    ),
                    if (canReview) ...[
                      WorkspaceSaveButton(
                        busy: _busy,
                        onPressed: () => _decide('approved'),
                        label: 'Approve request',
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: _busy ? null : () => _decide('denied'),
                        icon: const Icon(Icons.close_rounded),
                        label: const Text('Deny request'),
                      ),
                    ],
                    if (canCancel)
                      TextButton(
                        onPressed: _busy ? null : () => _decide('cancelled'),
                        child: const Text('Cancel request'),
                      ),
                  ],
                ],
              ),
      ),
    );
  }
}

class WorkspaceAuditPage extends StatelessWidget {
  const WorkspaceAuditPage({super.key, required this.api});
  final ApiClient api;
  @override
  Widget build(BuildContext context) => WorkspacePagedDirectory(
    api: api,
    path: '/audit-logs',
    title: 'Audit activity',
    description: 'A durable record of who changed this workspace, what happened, and the outcome.',
    rowBuilder: (context, row, onTap) => WorkspaceDirectoryTile(
      title: friendlyLabel(textOf(row['action'])),
      subtitle: '${auditActor(row)}\n${recordedAt(row['created_at'])}',
      icon: Icons.history_rounded,
      status: textOf(row['outcome']),
      onTap: onTap,
    ),
    onOpen: (row) => Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => WorkspaceAuditDetail(event: row)),
    ),
  );
}

String auditActor(JsonMap event) {
  final actor = objectOf(event['actor']);
  final name = textOf(actor['display_name']);
  if (name.isNotEmpty) return name;
  return textOf(actor['email']).isNotEmpty ? textOf(actor['email']) : 'System';
}

class WorkspaceAuditDetail extends StatelessWidget {
  const WorkspaceAuditDetail({super.key, required this.event});
  final JsonMap event;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Activity details')),
    body: SafeArea(
      top: false,
      child: WorkspaceBody(
        children: [
          WorkspaceCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  friendlyLabel(textOf(event['action'])),
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerLeft,
                  child: WorkspaceStatus(textOf(event['outcome'])),
                ),
                const SizedBox(height: 24),
                WorkspaceField('Actor', auditActor(event)),
                if (objectOf(event['actor'])['email'] != null)
                  WorkspaceField(
                    'Email',
                    textOf(objectOf(event['actor'])['email']),
                  ),
                WorkspaceField('Action', textOf(event['action'])),
                WorkspaceField(
                  'Resource type',
                  friendlyLabel(textOf(event['resource_type'])),
                ),
                if (event['resource_id'] != null)
                  WorkspaceField('Resource ID', textOf(event['resource_id'])),
                WorkspaceField('Recorded', recordedAt(event['created_at'])),
                WorkspaceField('Event ID', textOf(event['id'])),
              ],
            ),
          ),
          if (objectOf(event['details']).isNotEmpty)
            WorkspaceCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Change details',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 20),
                  WorkspaceJsonDetails(objectOf(event['details'])),
                ],
              ),
            ),
        ],
      ),
    ),
  );
}

class WorkspaceSettingsPage extends StatefulWidget {
  const WorkspaceSettingsPage({
    super.key,
    required this.api,
    required this.session,
    required this.onSessionChanged,
  });
  final ApiClient api;
  final AuthSession session;
  final Future<void> Function() onSessionChanged;
  @override
  State<WorkspaceSettingsPage> createState() => _WorkspaceSettingsPageState();
}

class _WorkspaceSettingsPageState extends State<WorkspaceSettingsPage> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  JsonMap? _workspace;
  String? _error, _notice;
  bool _loading = true, _busy = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final workspace = await widget.api.get(
        '/workspaces/${widget.session.activeWorkspaceId}',
      );
      if (mounted) {
        setState(() {
          _workspace = workspace;
          _name.text = textOf(workspace['name']);
          _loading = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate() || _busy) return;
    if (_name.text.trim() == _workspace!['name']) {
      setState(() => _notice = 'Your workspace name is already up to date.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final workspace = await widget.api.patch(
        '/workspaces/${widget.session.activeWorkspaceId}',
        body: {'name': _name.text.trim()},
      );
      if (!mounted) return;
      setState(() {
        _workspace = workspace;
        _notice = 'Workspace settings saved.';
        _busy = false;
      });
      await widget.onSessionChanged();
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Workspace settings')),
    body: SafeArea(
      top: false,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _workspace == null
          ? WorkspaceBody(
              children: [
                WorkspaceNotice(
                  _error ?? 'Could not load workspace settings.',
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
                  if (_notice != null) WorkspaceNotice(_notice!),
                  WorkspaceCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Workspace identity',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'A clear name helps your team find the right place to work.',
                          style: TextStyle(color: context.colors.textSecondary),
                        ),
                        const SizedBox(height: 24),
                        TextFormField(
                          controller: _name,
                          validator: requiredText,
                          maxLength: 255,
                          readOnly:
                              _busy || !widget.session.can('tenant.manage'),
                          decoration: const InputDecoration(
                            labelText: 'Workspace name',
                          ),
                        ),
                        const SizedBox(height: 20),
                        WorkspaceField(
                          'Code · fixed at creation',
                          textOf(_workspace!['code']),
                        ),
                        Text(
                          'Status · managed by platform control',
                          style: TextStyle(color: context.colors.textSecondary),
                        ),
                        const SizedBox(height: 8),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: WorkspaceStatus(textOf(_workspace!['status'])),
                        ),
                      ],
                    ),
                  ),
                  if (widget.session.can('tenant.manage'))
                    WorkspaceSaveButton(busy: _busy, onPressed: _save),
                ],
              ),
            ),
    ),
  );
}
