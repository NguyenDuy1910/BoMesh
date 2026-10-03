import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import '../knowledge/knowledge_models.dart';

/// Whether this person decides any kind of request.
bool canReviewRequests(AuthSession session) =>
    session.can('access.manage') || session.can('source.manage');

bool _reviewable(AuthSession session, _Request request) =>
    request.status == 'pending' &&
    request.requesterId != session.userId &&
    session.can(
      request.type == 'resource_access' ? 'access.manage' : 'source.manage',
    );

/// How many requests are waiting for this person's decision.
Future<int> countWaitingRequests(ApiClient api, AuthSession session) async {
  final page = await api.get('/approval-requests', query: {'page_size': 100});
  return objectList(page['items'])
      .map(_Request.fromJson)
      .where((request) => _reviewable(session, request))
      .length;
}

class _Request {
  _Request.fromJson(JsonMap value)
    : id = textOf(value['id']),
      type = textOf(value['request_type']),
      targetId = textOf(value['target_id']),
      status = textOf(value['status']),
      requesterId = textOf(objectOf(value['requester'])['id']),
      requester = _name(objectOf(value['requester'])),
      role = textOf(objectOf(value['requested_role'])['display_name']),
      reason = textOf(value['reason']),
      note = textOf(value['decision_note']),
      createdAt = textOf(value['created_at']);
  final String id, type, targetId, status, requesterId, requester;
  final String role, reason, note, createdAt;

  static String _name(JsonMap person) {
    final name = textOf(person['display_name']).trim();
    return name.isNotEmpty ? name : textOf(person['email'], 'Someone');
  }
}

/// Access requests: the ones waiting for your decision first, then your own.
///
/// A decision is one tap and a confirmation, on the card itself. Everything
/// else about access — roles, groups, sharing — is managed in the web console.
class RequestsPage extends StatefulWidget {
  const RequestsPage({super.key, required this.api, required this.session});
  final ApiClient api;
  final AuthSession session;
  @override
  State<RequestsPage> createState() => _RequestsPageState();
}

class _RequestsPageState extends State<RequestsPage> {
  List<_Request> _requests = [];
  final Map<String, String> _titles = {};
  bool _loading = true;
  String? _error, _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.api.get(
        '/approval-requests',
        query: {'page_size': 100},
      );
      final requests = objectList(page['items']).map(_Request.fromJson).toList();
      if (!mounted) return;
      setState(() {
        _requests = requests;
        _loading = false;
      });
      await _resolveTitles(requests);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  /// Name each collection once; a reviewer decides on a name, not an ID.
  Future<void> _resolveTitles(List<_Request> requests) async {
    final ids = requests
        .where((request) => request.type == 'resource_access')
        .map((request) => request.targetId)
        .where((id) => !_titles.containsKey(id))
        .toSet();
    for (final id in ids) {
      try {
        final collection = await widget.api.get(
          '/collections/${Uri.encodeComponent(id)}',
        );
        if (!mounted) return;
        setState(() => _titles[id] = textOf(collection['title'], 'a collection'));
      } catch (_) {
        // Not readable by this person: the card says "a collection".
      }
    }
  }

  Future<void> _decide(_Request request, String status) async {
    final verb = switch (status) {
      'approved' => 'Approve',
      'denied' => 'Deny',
      _ => 'Cancel',
    };
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('$verb this request?'),
        content: Text(switch (status) {
          'approved' => '${request.requester} gets ${request.role.isEmpty ? 'access' : request.role} to ${_target(request)}.',
          'denied' => '${request.requester} will see that the request was denied.',
          _ => 'The request stops waiting for a reviewer.',
        }),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Back'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(verb),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = request.id);
    try {
      await widget.api.patch(
        '/approval-requests/${Uri.encodeComponent(request.id)}',
        body: {'status': status},
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(switch (status) {
          'approved' => 'Approved',
          'denied' => 'Denied',
          _ => 'Request cancelled',
        })),
      );
      await _load();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  String _target(_Request request) => request.type == 'resource_access'
      ? _titles[request.targetId] ?? 'a collection'
      : 'the ${request.targetId} connector';

  @override
  Widget build(BuildContext context) {
    final waiting = _requests
        .where((request) => _reviewable(widget.session, request))
        .toList();
    final mine = _requests
        .where((request) => request.requesterId == widget.session.userId)
        .toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Access requests')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                children: [
                  if (_error != null)
                    _Message(
                      text: _error!,
                      action: TextButton(onPressed: _load, child: const Text('Try again')),
                    )
                  else if (waiting.isEmpty && mine.isEmpty)
                    const _Message(text: 'No access requests.'),
                  if (waiting.isNotEmpty) ...[
                    const _Heading('Waiting for you'),
                    for (final request in waiting)
                      _RequestCard(
                        title: '${request.requester} asks for ${request.role.isEmpty ? 'access' : request.role}',
                        detail: _target(request),
                        reason: request.reason,
                        when: readableDate(request.createdAt),
                        busy: _busy == request.id,
                        actions: [
                          TextButton(
                            onPressed: _busy == null ? () => _decide(request, 'denied') : null,
                            child: const Text('Deny'),
                          ),
                          FilledButton(
                            onPressed: _busy == null ? () => _decide(request, 'approved') : null,
                            child: const Text('Approve'),
                          ),
                        ],
                      ),
                  ],
                  if (mine.isNotEmpty) ...[
                    const _Heading('Your requests'),
                    for (final request in mine)
                      _RequestCard(
                        title: _target(request),
                        detail: switch (request.status) {
                          'pending' => 'Waiting for review',
                          'approved' => 'Approved',
                          'denied' => request.note.isEmpty ? 'Denied' : 'Denied: ${request.note}',
                          _ => 'Cancelled',
                        },
                        when: readableDate(request.createdAt),
                        busy: _busy == request.id,
                        actions: [
                          if (request.status == 'pending')
                            TextButton(
                              onPressed: _busy == null ? () => _decide(request, 'cancelled') : null,
                              child: const Text('Cancel request'),
                            ),
                        ],
                      ),
                  ],
                ],
              ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 16, 4, 8),
    child: Text(text, style: Theme.of(context).textTheme.titleSmall),
  );
}

class _Message extends StatelessWidget {
  const _Message({required this.text, this.action});
  final String text;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 48),
    child: Column(
      children: [
        Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(color: context.colors.textSecondary),
        ),
        ?action,
      ],
    ),
  );
}

class _RequestCard extends StatelessWidget {
  const _RequestCard({
    required this.title,
    required this.detail,
    required this.when,
    required this.busy,
    required this.actions,
    this.reason = '',
  });
  final String title, detail, when, reason;
  final bool busy;
  final List<Widget> actions;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            '$detail · $when',
            style: TextStyle(color: context.colors.textSecondary),
          ),
          if (reason.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('“$reason”'),
          ],
          if (actions.isNotEmpty)
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (busy)
                  const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                else ...[
                  for (final action in actions) ...[
                    const SizedBox(width: 8),
                    action,
                  ],
                ],
              ],
            )
          else
            const SizedBox(height: 6),
        ],
      ),
    ),
  );
}
