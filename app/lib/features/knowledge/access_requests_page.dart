import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

class _AccessRequest {
  _AccessRequest.fromJson(JsonMap value)
    : id = textOf(value['id']),
      targetId = textOf(value['target_id']),
      requesterId = textOf(objectOf(value['requester'])['id']),
      type = textOf(value['request_type']),
      status = textOf(value['status']),
      role = textOf(objectOf(value['requested_role'])['display_name']),
      reason = textOf(value['reason']),
      decision = textOf(value['decision_note']),
      createdAt = textOf(value['created_at']);
  final String id,
      targetId,
      requesterId,
      type,
      status,
      role,
      reason,
      decision,
      createdAt;
}

class AccessRequestsPage extends StatefulWidget {
  const AccessRequestsPage({
    super.key,
    required this.api,
    required this.session,
    required this.collections,
  });
  final ApiClient api;
  final AuthSession session;
  final List<KnowledgeCollection> collections;
  @override
  State<AccessRequestsPage> createState() => _AccessRequestsPageState();
}

class _AccessRequestsPageState extends State<AccessRequestsPage> {
  List<_AccessRequest> _requests = [];
  bool _loading = true;
  String? _error, _busy;
  int _page = 1, _received = 0, _total = 0;
  bool get _current =>
      mounted && widget.api.accessToken == widget.session.accessToken;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final page = more ? _page + 1 : 1;
    try {
      final value = await widget.api.get(
        '/approval-requests',
        query: {'page': page, 'page_size': 30},
      );
      if (!_current) return;
      final items = objectList(value['items']);
      final own = items
          .map(_AccessRequest.fromJson)
          .where(
            (request) =>
                request.requesterId == widget.session.userId &&
                request.type == 'resource_access',
          )
          .toList();
      setState(() {
        _requests = more ? [..._requests, ...own] : own;
        _received = more ? _received + items.length : items.length;
        _total = numberOf(value['total']);
        _page = page;
        _loading = false;
      });
    } catch (error) {
      if (_current) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _create() async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (context) => _RequestEditor(
        api: widget.api,
        session: widget.session,
        collections: widget.collections,
      ),
    );
    if (_current && changed == true) await _load();
  }

  Future<void> _cancel(_AccessRequest request) async {
    final confirmed = await confirmKnowledgeAction(
      context,
      title: 'Cancel access request?',
      message: 'This request will no longer wait for a reviewer. You can send a new request later.',
      confirmLabel: 'Cancel request',
    );
    if (!_current || !confirmed) return;
    setState(() => _busy = request.id);
    try {
      await widget.api.patch(
        '/approval-requests/${Uri.encodeComponent(request.id)}',
        body: const {'status': 'cancelled'},
      );
      if (_current) await _load();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _busy = null);
    }
  }

  String _collectionTitle(String id) {
    for (final collection in widget.collections) {
      if (collection.id == id) return collection.title;
    }
    return 'Collection $id';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('My access requests')),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: _busy == null ? _create : null,
      icon: const Icon(Icons.add),
      label: const Text('Request access'),
    ),
    body: SafeArea(
      top: false,
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 104),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            Text(
              'Request a role in a collection. A workspace reviewer decides whether to approve it.',
              style: TextStyle(
                color: context.colors.textSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 24),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: KnowledgeNotice(
                  title: 'Requests could not be loaded',
                  message: _error,
                  onAction: _load,
                  danger: true,
                ),
              ),
            if (_requests.isEmpty && !_loading && _error == null)
              const KnowledgeNotice(
                title: 'No access requests',
                message: 'Ask a collection owner for its ID, or request a different role in a collection you can already read.',
                icon: Icons.lock_open_outlined,
              ),
            for (final request in _requests)
              Card(
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _collectionTitle(request.targetId),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 12,
                        runSpacing: 8,
                        children: [
                          Chip(label: Text(sentenceCase(request.status))),
                          Text(request.role),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Requested ${readableDate(request.createdAt)}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (request.reason.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(request.reason),
                        ),
                      if (request.decision.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text('Reviewer note: ${request.decision}'),
                        ),
                      if (request.status == 'pending')
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: OutlinedButton(
                            onPressed: _busy == null
                                ? () => _cancel(request)
                                : null,
                            child: Text(
                              _busy == request.id
                                  ? 'Cancelling…'
                                  : 'Cancel request',
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            if (_loading)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: CircularProgressIndicator(),
                ),
              ),
            if (!_loading && _received < _total)
              OutlinedButton(
                onPressed: () => _load(more: true),
                child: const Text('Load more requests'),
              ),
          ],
        ),
      ),
    ),
  );
}

class _RequestEditor extends StatefulWidget {
  const _RequestEditor({
    required this.api,
    required this.session,
    required this.collections,
  });
  final ApiClient api;
  final AuthSession session;
  final List<KnowledgeCollection> collections;
  @override
  State<_RequestEditor> createState() => _RequestEditorState();
}

class _RequestEditorState extends State<_RequestEditor> {
  final _form = GlobalKey<FormState>();
  final _target = TextEditingController();
  final _reason = TextEditingController();
  String _selected = '';
  String _role = 'viewer';
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _target.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_form.currentState?.validate() != true || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.post(
        '/approval-requests',
        body: {
          'request_type': 'resource_access',
          'target_id': _selected.isEmpty ? _target.text.trim() : _selected,
          'details': {'role': 'collection_$_role'},
          if (_reason.text.trim().isNotEmpty) 'reason': _reason.text.trim(),
        },
      );
      if (mounted && widget.api.accessToken == widget.session.accessToken) {
        Navigator.pop(context, true);
      }
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
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      scrollable: true,
      title: const Text('Request collection access'),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DropdownButtonFormField<String>(
                initialValue: _selected,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Collection'),
                items: [
                  const DropdownMenuItem(
                    value: '',
                    child: Text('Enter a collection ID'),
                  ),
                  for (final collection in widget.collections)
                    DropdownMenuItem(
                      value: collection.id,
                      child: Text(
                        collection.title,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _selected = value ?? ''),
              ),
              if (_selected.isEmpty) ...[
                const SizedBox(height: 16),
                TextFormField(
                  controller: _target,
                  decoration: const InputDecoration(
                    labelText: 'Collection ID',
                    helperText: 'Ask the owner to share the collection ID.',
                  ),
                  validator: (value) =>
                      RegExp(
                        r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
                      ).hasMatch(value?.trim() ?? '')
                      ? null
                      : 'Enter a valid collection ID',
                ),
              ],
              const SizedBox(height: 16),
              DropdownButtonFormField<String>(
                initialValue: _role,
                decoration: const InputDecoration(labelText: 'Requested role'),
                items: [
                  for (final role in ['viewer', 'editor', 'owner'])
                    DropdownMenuItem(
                      value: role,
                      child: Text(sentenceCase(role)),
                    ),
                ],
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _role = value!),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _reason,
                decoration: const InputDecoration(
                  labelText: 'Reason (optional)',
                ),
                minLines: 3,
                maxLines: 5,
                maxLength: 4000,
              ),
              if (_error != null)
                KnowledgeNotice(
                  title: 'Request could not be sent',
                  message: _error,
                  danger: true,
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(_busy ? 'Sending…' : 'Send request'),
        ),
      ],
    ),
  );
}
