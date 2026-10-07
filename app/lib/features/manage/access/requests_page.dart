import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import '../../auth/session.dart';
import 'access_sheets.dart';

/// One approval request (`GET /approval-requests`).
class _Request {
  _Request.fromJson(JsonMap value)
    : id = textOf(value['id']),
      type = textOf(value['request_type']),
      targetId = textOf(value['target_id']),
      status = textOf(value['status']),
      requesterId = textOf(objectOf(value['requester'])['id']),
      requester = personName(objectOf(value['requester'])),
      role = textOf(objectOf(value['requested_role'])['display_name']).trim(),
      reason = textOf(value['reason']).trim(),
      decidedBy = textOf(value['decided_by_user_id']),
      decidedAt = value['decided_at'] ?? value['updated_at'],
      createdAt = value['created_at'];

  final String id, type, targetId, status, requesterId, requester;
  final String role, reason, decidedBy;
  final Object? decidedAt, createdAt;

  bool get pending => status == 'pending';
  bool get forCollection => type == 'resource_access';
}

/// Pending requests of a kind this caller has permission to review.
bool _reviewable(AuthSession session, _Request request) =>
    request.pending &&
    session.can(request.forCollection ? 'access.manage' : 'source.manage');

Future<List<_Request>> _loadRequests(ApiClient api) async =>
    (await readAllPages(
      api,
      '/approval-requests',
      limit: 300,
    )).map(_Request.fromJson).toList();

/// How many requests are waiting for this person's decision.
Future<int> countWaitingRequests(ApiClient api, AuthSession session) async =>
    (await _loadRequests(api))
        .where((request) => _reviewable(session, request))
        .length;

/// When the longest-waiting request for this person's decision was made.
Future<DateTime?> oldestWaitingRequest(
  ApiClient api,
  AuthSession session,
) async {
  DateTime? oldest;
  for (final request in await _loadRequests(api)) {
    if (!_reviewable(session, request)) continue;
    final created = parseTime(request.createdAt);
    if (created != null && (oldest == null || created.isBefore(oldest))) {
      oldest = created;
    }
  }
  return oldest;
}

/// Access requests: the ones waiting for your decision, as cards with
/// Approve and Deny side by side; then your own; then what was decided.
class RequestsPage extends StatefulWidget {
  const RequestsPage({super.key, this.initialRequestId, this.embedded = false});
  final String? initialRequestId;
  final bool embedded;

  @override
  State<RequestsPage> createState() => _RequestsPageState();
}

class _RequestsPageState extends State<RequestsPage> {
  List<_Request>? _requests;
  final Map<String, String> _titles = {};
  Object? _error;
  final Set<String> _busy = {};
  late ApiClient _api;
  late AuthSession _session;
  late Future<void> Function() _refreshWaiting;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    final changed = !_started || scope.api != _api || scope.session != _session;
    _api = scope.api;
    _session = scope.session;
    _refreshWaiting = scope.refreshWaitingRequests;
    if (changed) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final requests = await _loadRequests(_api);
      if (!mounted) return;
      final targetId = widget.initialRequestId;
      if (targetId != null && !requests.any((request) => request.id == targetId)) {
        requests.add(_Request.fromJson(await _api.get('/approval-requests/${Uri.encodeComponent(targetId)}')));
      }
      if (!mounted) return;
      setState(() => _requests = requests);
      await _resolveTitles(requests);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  /// Name each collection once: a reviewer decides on a name, not an id.
  Future<void> _resolveTitles(List<_Request> requests) async {
    final ids = {
      for (final request in requests)
        if (request.forCollection && !_titles.containsKey(request.targetId))
          request.targetId,
    };
    await Future.wait(
      ids.map((id) async {
        try {
          final collection = await _api.get(
            '/collections/${Uri.encodeComponent(id)}',
          );
          final title = textOf(collection['title']).trim();
          if (mounted && title.isNotEmpty) setState(() => _titles[id] = title);
        } catch (_) {
          // Not readable here: the card says "a collection".
        }
      }),
    );
  }

  String _target(_Request request) => request.forCollection
      ? _titles[request.targetId] ?? 'a collection'
      : 'the ${request.targetId} connector';

  Future<void> _decide(
    _Request request,
    String status, {
    String? note,
    required String done,
  }) async {
    setState(() => _busy.add(request.id));
    try {
      await _api.patch(
        '/approval-requests/${Uri.encodeComponent(request.id)}',
        body: {
          'status': status,
          if (note != null && note.isNotEmpty) 'decision_note': note,
        },
      );
      if (!mounted) return;
      showToast(context, done);
      await Future.wait([_load(), _refreshWaiting()]);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy.remove(request.id));
    }
  }

  Future<void> _approve(_Request request) => _decide(
    request,
    'approved',
    done: request.forCollection ? 'Approved — ${request.requester} can open ${_target(request)}' : 'Connector request approved',
  );

  Future<void> _deny(_Request request) async {
    final note = await promptText(
      context,
      title: 'Deny this request?',
      subtitle:
          '${request.requester} will see that it was denied. Add a note if it helps.',
      hint: 'Note (optional)',
      confirmLabel: 'Deny',
      allowEmpty: true,
      maxLines: 3,
    );
    if (note == null || !mounted) return;
    await _decide(request, 'denied', note: note, done: 'Request denied');
  }

  Future<void> _cancel(_Request request) async {
    final confirmed = await confirmAction(
      context,
      title: 'Cancel this request?',
      message: 'It stops waiting for a reviewer. You can ask again later.',
      confirmLabel: 'Cancel request',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    await _decide(request, 'cancelled', done: 'Request cancelled');
  }

  @override
  Widget build(BuildContext context) {
    final allRequests = _requests;
    final requests = widget.initialRequestId == null
        ? allRequests
        : allRequests?.where((request) => request.id == widget.initialRequestId).toList();
    final waiting = [
      for (final request in requests ?? const <_Request>[])
        if (_reviewable(_session, request)) request,
    ]..sort((a, b) => _compareTime(a.createdAt, b.createdAt));
    final mine = [
      for (final request in requests ?? const <_Request>[])
        if (request.pending && request.requesterId == _session.userId && !_reviewable(_session, request)) request,
    ];
    final decided = [
      for (final request in requests ?? const <_Request>[])
        if (!request.pending) request,
    ]..sort((a, b) => _compareTime(b.decidedAt, a.decidedAt));

    final Widget body;
    if (requests == null) {
      body = _error != null
          ? ErrorView(error: _error!, onRetry: _load)
          : const LoadingView();
    } else if (waiting.isEmpty && mine.isEmpty && decided.isEmpty) {
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            EmptyView(
              icon: Icons.shield_outlined,
              title: 'No access requests',
              message: 'When someone asks to open a collection, the request waits here for a decision.',
            ),
          ],
        ),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding.copyWith(top: 8),
          children: [
            if (waiting.isEmpty &&
                _session.canAny(const ['access.manage', 'source.manage']))
              const AllClearCard(text: 'Nothing is waiting for your decision.'),
            for (final request in waiting) ...[
              _RequestCard(
                requester: request.requester,
                requesterId: request.requesterId,
                role: request.role.isEmpty ? 'Access' : request.role,
                target: _target(request),
                when: relativeTime(request.createdAt),
                reason: request.reason,
                busy: _busy.contains(request.id),
                onApprove: () => _approve(request),
                onDeny: () => _deny(request),
              ),
              const SizedBox(height: 10),
            ],
            if (mine.isNotEmpty) ...[
              const SectionLabel('Your requests'),
              ListGroup(
                children: [
                  for (final request in mine)
                    ListRow(
                      leading: ToneTile(
                        tone: request.forCollection
                            ? toneFor(request.targetId)
                            : Tone.cyan,
                        icon: request.forCollection
                            ? Icons.menu_book_outlined
                            : Icons.power_outlined,
                        size: TileSize.small,
                      ),
                      title: _sentence(_target(request)),
                      subtitle:
                          '${request.role.isEmpty ? 'Access' : request.role} · asked ${relativeTime(request.createdAt)}',
                      trailing: _busy.contains(request.id)
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : TextButton(
                              onPressed: () => _cancel(request),
                              style: TextButton.styleFrom(
                                foregroundColor: context.colors.ink2,
                              ),
                              child: const Text('Cancel request'),
                            ),
                    ),
                ],
              ),
            ],
            if (decided.isNotEmpty) ...[
              const SectionLabel('Decided'),
              ListGroup(
                children: [
                  for (final request in decided.take(20))
                    ListRow(
                      leading: PersonAvatar(
                        name: request.requester,
                        seed: request.requesterId,
                      ),
                      title: request.requesterId == _session.userId
                          ? 'You → ${_target(request)}'
                          : '${request.requester} → ${_target(request)}',
                      subtitle: _decidedLine(request),
                      trailing: _statusPill(request.status),
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    }
    if (widget.embedded) return body;

    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(
        paper: true,
        title: 'Access requests',
        subtitle: requests == null ? null : '${waiting.length} waiting',
      ),
      body: body,
    );
  }

  String _decidedLine(_Request request) {
    final verb = switch (request.status) {
      'approved' => 'Approved',
      'denied' => 'Denied',
      _ => 'Cancelled',
    };
    final by = request.status == 'cancelled'
        ? ''
        : request.decidedBy == _session.userId
        ? ' by you'
        : '';
    final when = relativeTime(request.decidedAt);
    return when.isEmpty ? '$verb$by' : '$verb$by · $when';
  }
}

int _compareTime(Object? a, Object? b) {
  final first = parseTime(a), second = parseTime(b);
  if (first == null || second == null) return 0;
  return first.compareTo(second);
}

String _sentence(String value) =>
    value.isEmpty ? value : '${value[0].toUpperCase()}${value.substring(1)}';

StatusPill _statusPill(String status) => switch (status) {
  'approved' => const StatusPill(label: 'Approved', tone: StatusTone.success),
  'denied' => const StatusPill(label: 'Denied', tone: StatusTone.danger),
  _ => const StatusPill(label: 'Cancelled', tone: StatusTone.neutral),
};

/// Who asks, for what, and why — then Deny and Approve, side by side.
class _RequestCard extends StatelessWidget {
  const _RequestCard({
    required this.requester,
    required this.requesterId,
    required this.role,
    required this.target,
    required this.when,
    required this.reason,
    required this.busy,
    required this.onApprove,
    required this.onDeny,
  });
  final String requester, requesterId, role, target, when, reason;
  final bool busy;
  final VoidCallback onApprove, onDeny;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: colors.canvas,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              PersonAvatar(name: requester, seed: requesterId),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      requester,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text.rich(
                      TextSpan(
                        style: TextStyle(color: colors.ink3, fontSize: 13),
                        children: [
                          TextSpan(text: '$role → '),
                          TextSpan(
                            text: target,
                            style: TextStyle(
                              color: colors.ink2,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (when.isNotEmpty) TextSpan(text: ' · $when'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (reason.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: colors.subtle,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                reason,
                style: TextStyle(
                  color: colors.ink2,
                  fontSize: 14,
                  height: 1.45,
                ),
              ),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  style: secondaryButtonStyle(context, small: true),
                  onPressed: busy ? null : onDeny,
                  child: const Text('Deny'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.icon(
                  style: smallPrimaryButtonStyle(),
                  onPressed: busy ? null : onApprove,
                  icon: busy
                      ? SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: colors.ink3,
                          ),
                        )
                      : const Icon(Icons.check_rounded, size: 18),
                  label: const Text('Approve'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
