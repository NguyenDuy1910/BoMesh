import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';

/// The device's IANA zone for usage buckets. The platform reports an
/// abbreviation ("ICT") on most devices, so a whole-hour offset becomes its
/// fixed `Etc/GMT` zone (whose sign is inverted by convention); anything else
/// falls back to UTC.
String localTimeZone() {
  final now = DateTime.now();
  final name = now.timeZoneName;
  if (name.contains('/')) return name;
  final offset = now.timeZoneOffset;
  if (offset == Duration.zero) return 'UTC';
  if (offset.inMinutes % 60 != 0) return 'UTC';
  final hours = offset.inHours;
  return 'Etc/GMT${hours > 0 ? '-' : '+'}${hours.abs()}';
}

enum _Window {
  day('24h', '24 hours'),
  week('7d', '7 days'),
  month('30d', '30 days');

  const _Window(this.query, this.label);
  final String query, label;
}

enum _Records { signIns, audit }

/// Readable changes and sign-ins first; usage remains available in a sheet.
class ActivityPage extends StatefulWidget {
  const ActivityPage({super.key});

  @override
  State<ActivityPage> createState() => _ActivityPageState();
}

class _ActivityPageState extends State<ActivityPage> {
  static const _pageSize = 20;

  ApiClient? _api;
  String _workspaceId = '';
  _Window _window = _Window.week;
  JsonMap? _activity;
  Object? _activityError;

  _Records _records = _Records.audit;
  String _search = '';
  String? _sessionStatus; // null = all, 'active', 'ended'
  List<JsonMap>? _rows;
  int _total = 0;
  int _page = 1;
  bool _loadingMore = false;
  Object? _rowsError;
  int _request = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    if (!identical(scope.api, _api) ||
        scope.session.activeWorkspaceId != _workspaceId) {
      _api = scope.api;
      _workspaceId = scope.session.activeWorkspaceId;
      _loadActivity();
      _loadRows();
    }
  }

  Future<void> _refresh() => Future.wait([_loadActivity(), _loadRows()]);

  Future<void> _loadActivity() async {
    final window = _window;
    try {
      final activity = await _api!.get(
        '/workspaces/${Uri.encodeComponent(_workspaceId)}/activity',
        query: {'window': window.query, 'tz': localTimeZone()},
      );
      if (!mounted || window != _window) return;
      setState(() {
        _activity = activity;
        _activityError = null;
      });
    } catch (error) {
      if (mounted && window == _window) setState(() => _activityError = error);
    }
  }

  String get _recordsPath =>
      _records == _Records.signIns ? '/access-sessions' : '/audit-logs';

  Map<String, Object?> _query(int page) => {
    'page': page,
    'page_size': _pageSize,
    'search': _search,
    if (_records == _Records.signIns) 'status': _sessionStatus,
  };

  Future<void> _loadRows() async {
    final request = ++_request;
    try {
      final page = await _api!.get(_recordsPath, query: _query(1));
      if (!mounted || request != _request) return;
      setState(() {
        _rows = objectList(page['items']);
        _total = intOf(page['total']);
        _page = 1;
        _rowsError = null;
      });
    } catch (error) {
      if (mounted && request == _request) setState(() => _rowsError = error);
    }
  }

  Future<void> _showMore() async {
    final request = _request;
    setState(() => _loadingMore = true);
    try {
      final page = await _api!.get(_recordsPath, query: _query(_page + 1));
      if (!mounted || request != _request) return;
      setState(() {
        _rows = [...?_rows, ...objectList(page['items'])];
        _total = intOf(page['total']);
        _page++;
      });
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _switchRecords(_Records records) {
    if (records == _records) return;
    setState(() {
      _records = records;
      _rows = null;
      _rowsError = null;
    });
    _loadRows();
  }

  Future<void> _pickWindow() async {
    final picked = await showAppSheet<_Window>(
      context,
      title: 'Period',
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final window in _Window.values)
            SheetOption(
              icon: Icons.calendar_today_outlined,
              title: window.label,
              subtitle: window == _Window.day ? 'Hour by hour' : 'Day by day',
              selected: window == _window,
              onTap: () => Navigator.pop(sheetContext, window),
            ),
        ],
      ),
    );
    if (picked == null || picked == _window || !mounted) return;
    setState(() {
      _window = picked;
      _activity = null;
      _activityError = null;
    });
    _loadActivity();
  }

  Future<void> _openFilters() async {
    final result = await showAppSheet<(String, String?)>(
      context,
      title: _records == _Records.signIns
          ? 'Filter sign-ins'
          : 'Filter audit log',
      builder: (_) => _FilterBody(
        search: _search,
        status: _sessionStatus,
        withStatus: _records == _Records.signIns,
      ),
    );
    if (result == null || !mounted) return;
    setState(() {
      _search = result.$1;
      _sessionStatus = result.$2;
      _rows = null;
      _rowsError = null;
    });
    _loadRows();
  }

  void _showUsage() => showAppSheet<void>(
    context,
    title: 'Workspace usage · ${_window.label}',
    scrollable: true,
    builder: (_) => Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: _summary(),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.paper,
      appBar: AppHeader(
        title: 'Activity',
        paper: true,
        actions: [
          IconButton(tooltip: 'Usage summary', onPressed: _showUsage, icon: const Icon(Icons.bar_chart_rounded)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding,
          children: [
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: Segmented<_Records>(
                    segments: const {
                      _Records.audit: 'Changes',
                      _Records.signIns: 'Sign-ins',
                    },
                    selected: _records,
                    onChanged: _switchRecords,
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  tooltip: 'Filter',
                  onPressed: _openFilters,
                  icon: Badge(
                    isLabelVisible:
                        _search.isNotEmpty ||
                        (_records == _Records.signIns &&
                            _sessionStatus != null),
                    smallSize: 7,
                    child: const Icon(Icons.tune_rounded),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ..._recordList(),
            const SizedBox(height: 16),
            Row(children: [
              const Expanded(child: Text('Usage summary period')),
              _PeriodChip(label: _window.label, onTap: _pickWindow),
            ]),
          ],
        ),
      ),
    );
  }

  List<Widget> _summary() {
    final activity = _activity;
    if (activity == null) {
      return [
        if (_activityError != null)
          ErrorView(error: _activityError!, onRetry: _loadActivity)
        else
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: LoadingView(),
          ),
      ];
    }
    final totals = objectOf(activity['totals']);
    final previous = objectOf(activity['previous']);
    final buckets = objectList(activity['buckets']);
    final hourly = textOf(activity['bucket']) == 'hour';
    final latest = buckets.isEmpty ? 0 : intOf(buckets.last['questions']);
    return [
      TwoColumnGrid(
        children: [
          MetricCard.trend(
            label: 'Questions',
            current: intOf(totals['questions']),
            previous: intOf(previous['questions']),
          ),
          MetricCard.trend(
            label: 'Active people',
            current: intOf(totals['active_users']),
            previous: intOf(previous['active_users']),
          ),
        ],
      ),
      const SizedBox(height: 8),
      _ChartCard(
        title: hourly ? 'Questions per hour' : 'Questions per day',
        aside: '${hourly ? 'This hour' : 'Today'} ${groupedNumber(latest)}',
        buckets: buckets,
        hourly: hourly,
      ),
    ];
  }

  List<Widget> _recordList() {
    final rows = _rows;
    if (rows == null) {
      return [
        if (_rowsError != null)
          ErrorView(error: _rowsError!, onRetry: _loadRows)
        else
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: LoadingView(),
          ),
      ];
    }
    if (rows.isEmpty) {
      final filtered =
          _search.isNotEmpty ||
          (_records == _Records.signIns && _sessionStatus != null);
      return [
        EmptyView(
          icon: _records == _Records.signIns
              ? Icons.login_rounded
              : Icons.notes_rounded,
          title: filtered
              ? 'Nothing matches these filters'
              : _records == _Records.signIns
              ? 'No sign-ins yet'
              : 'No changes recorded yet',
          actionLabel: filtered ? 'Clear filters' : null,
          onAction: filtered
              ? () {
                  setState(() {
                    _search = '';
                    _sessionStatus = null;
                    _rows = null;
                  });
                  _loadRows();
                }
              : null,
        ),
      ];
    }
    return [
      ListGroup(
        children: [
          for (final row in rows)
            _records == _Records.signIns ? _signInRow(row) : _auditRow(row),
        ],
      ),
      if (rows.length < _total)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: TextButton(
            onPressed: _loadingMore ? null : _showMore,
            child: Text(_loadingMore ? 'Loading…' : 'Show more'),
          ),
        ),
    ];
  }

  Widget _signInRow(JsonMap row) {
    final user = objectOf(row['user']);
    final name = _person(user);
    return ListRow(
      leading: PersonAvatar(name: name, seed: textOf(user['id'], name)),
      title: name,
      subtitle: '${_signInMethod(row)} · ${relativeTime(row['started_at'])}',
      trailing: _sessionPill(textOf(row['status'])),
      onTap: () => _showSignIn(row),
    );
  }

  Widget _auditRow(JsonMap row) {
    final actor = objectOf(row['actor']);
    return ListRow(
      title: describeAuditAction(textOf(row['action'])),
      subtitle: '${_person(actor)} · ${relativeTime(row['created_at'])}',
      trailing: _outcomePill(textOf(row['outcome'])),
      onTap: () => _showAudit(row),
    );
  }

  void _showSignIn(JsonMap row) {
    final user = objectOf(row['user']);
    final email = textOf(user['email']);
    final ended = row['ended_at'];
    showAppSheet<void>(
      context,
      title: _person(user),
      subtitle: email.isEmpty || email == _person(user) ? null : email,
      scrollable: true,
      builder: (_) => _DetailList(
        facts: [
          ('Status', null, _sessionPill(textOf(row['status']))),
          (
            'How',
            '${_signInMethod(row)}${textOf(row['entry']) == 'workspace_switch' ? ' · switched workspace' : ''}',
            null,
          ),
          ('Signed in', exactTime(row['started_at']), null),
          if (row['last_seen_at'] != null)
            ('Last seen', exactTime(row['last_seen_at']), null),
          if (ended != null)
            (
              'Ended',
              [
                exactTime(ended),
                if (textOf(row['end_reason']).isNotEmpty)
                  sentenceCase(textOf(row['end_reason'])),
              ].join(' · '),
              null,
            ),
        ],
      ),
    );
  }

  void _showAudit(JsonMap row) {
    final actor = objectOf(row['actor']);
    final details = objectOf(row['details']);
    final changed = details['changed_fields'] is List
        ? (details['changed_fields'] as List)
              .map((field) => sentenceCase(field.toString()).toLowerCase())
              .join(', ')
        : '';
    showAppSheet<void>(
      context,
      title: describeAuditAction(textOf(row['action'])),
      scrollable: true,
      builder: (_) => _DetailList(
        facts: [
          ('Who', _person(actor), null),
          ('What', describeAuditAction(textOf(row['action'])), null),
          if (textOf(row['resource_type']).isNotEmpty)
            ('Resource', _resourceWord(textOf(row['resource_type'])), null),
          if (changed.isNotEmpty) ('Changed', sentenceCase(changed), null),
          ('When', exactTime(row['created_at']), null),
          ('Outcome', null, _outcomePill(textOf(row['outcome']))),
        ],
      ),
    );
  }
}

String _person(JsonMap person) {
  final name = textOf(person['display_name']).trim();
  if (name.isNotEmpty) return name;
  final email = textOf(person['email']).trim();
  return email.isEmpty ? 'System' : email;
}

String _signInMethod(JsonMap row) =>
    switch (textOf(row['authentication_method'])) {
      'password' => 'Password',
      'google' => 'Google',
      'oidc' => 'Single sign-on',
      'saml' => 'SAML single sign-on',
      'internal' => 'Development sign-in',
      final other => other.isEmpty ? 'Sign-in' : sentenceCase(other),
    };

StatusPill _sessionPill(String status) => switch (status) {
  'active' => const StatusPill(label: 'Active', tone: StatusTone.success),
  'revoked' => const StatusPill(label: 'Revoked', tone: StatusTone.danger),
  _ => const StatusPill(label: 'Ended', tone: StatusTone.neutral),
};

StatusPill _outcomePill(String outcome) => outcome == 'success'
    ? const StatusPill(label: 'Done', tone: StatusTone.success)
    : StatusPill(
        label: outcome.isEmpty ? 'Unknown' : 'Failed',
        tone: outcome.isEmpty ? StatusTone.neutral : StatusTone.danger,
      );

const _resourceWords = {
  'tenant': 'workspace',
  'ingestion source': 'source',
  'ingestion': 'ingestion',
  'integration connection': 'connection',
  'user': 'member',
  'role assignment platform admin': 'platform admin',
};

String _resourceWord(String raw) {
  final words = raw.replaceAll(RegExp(r'[_.]+'), ' ').trim();
  return sentenceCase(_resourceWords[words] ?? words);
}

/// "collection.updated" → "Updated a collection"; dotted audit actions read
/// as sentences, never as codes.
String describeAuditAction(String action) {
  const special = {
    'collection.access.granted': 'Shared a collection',
    'collection.access.revoked': 'Removed access to a collection',
    'group.members_replaced': 'Changed group members',
    'ingestion.source.sync_requested': 'Started a source sync',
    'integration.connection.authorized': 'Signed in to a connection',
    'role_assignment.platform_admin.granted': 'Made a platform admin',
  };
  if (special[action] case final text?) return text;
  final parts = action.split('.').where((part) => part.isNotEmpty).toList();
  if (parts.length < 2) return action.isEmpty ? 'Change' : sentenceCase(action);
  final verb = _pastTense(parts.removeLast().replaceAll('_', ' '));
  final thing = _resourceWord(parts.join(' ')).toLowerCase();
  final article = RegExp(r'^[aeiou]').hasMatch(thing) ? 'an' : 'a';
  return '${sentenceCase(verb)} $article $thing';
}

String _pastTense(String verb) {
  if (verb.endsWith('ed')) return verb;
  if (verb.endsWith('e')) return '${verb}d';
  if (verb.endsWith('y')) return '${verb.substring(0, verb.length - 1)}ied';
  return '${verb}ed';
}

class _PeriodChip extends StatelessWidget {
  const _PeriodChip({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Material(
        color: colors.subtle,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.calendar_today_outlined,
                  size: 14,
                  color: colors.ink2,
                ),
                const SizedBox(width: 6),
                Text(
                  label,
                  style: TextStyle(
                    color: colors.ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 2),
                Icon(Icons.expand_more_rounded, size: 18, color: colors.ink3),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ChartCard extends StatelessWidget {
  const _ChartCard({
    required this.title,
    required this.aside,
    required this.buckets,
    required this.hourly,
  });
  final String title, aside;
  final List<JsonMap> buckets;
  final bool hourly;

  static const _weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  String _label(int index) {
    final start = parseTime(buckets[index]['start']);
    if (start == null) return '';
    final count = buckets.length;
    if (hourly) return index % 6 == 0 ? '${start.hour}:00' : '';
    if (count <= 7) return _weekdays[start.weekday - 1];
    final step = (count / 6).ceil();
    return (count - 1 - index) % step == 0 ? '${start.day}' : '';
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final values = [for (final b in buckets) intOf(b['questions'])];
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
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    color: colors.ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Text(aside, style: TextStyle(color: colors.ink3, fontSize: 13)),
            ],
          ),
          const SizedBox(height: 10),
          Semantics(
            label: '$title: ${values.join(', ')}',
            child: SizedBox(
              height: 120,
              child: CustomPaint(
                painter: _BarChartPainter(
                  values: values,
                  labels: [for (var i = 0; i < values.length; i++) _label(i)],
                  bar: colors.brand,
                  quietBar: Color.lerp(colors.canvas, colors.brand, 0.22)!,
                  labelColor: colors.ink3,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Rounded bars, the latest in full violet and the rest quiet, with small
/// labels underneath.
class _BarChartPainter extends CustomPainter {
  _BarChartPainter({
    required this.values,
    required this.labels,
    required this.bar,
    required this.quietBar,
    required this.labelColor,
  });
  final List<int> values;
  final List<String> labels;
  final Color bar, quietBar, labelColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty) return;
    const labelHeight = 16.0;
    final chartHeight = size.height - labelHeight;
    final peak = values.reduce((a, b) => a > b ? a : b);
    final slot = size.width / values.length;
    final gap = (slot * 0.24).clamp(1.0, 12.0);
    final width = slot - gap;
    final radius = Radius.circular((width / 5).clamp(1.0, 6.0));
    for (var index = 0; index < values.length; index++) {
      final ratio = peak == 0 ? 0.0 : values[index] / peak;
      final height = (chartHeight * ratio).clamp(3.0, chartHeight);
      final left = index * slot + gap / 2;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(left, chartHeight - height, width, height),
          radius,
        ),
        Paint()..color = index == values.length - 1 ? bar : quietBar,
      );
      final label = labels[index];
      if (label.isEmpty) continue;
      final text = TextPainter(
        text: TextSpan(
          text: label,
          style: TextStyle(color: labelColor, fontSize: 10),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      final x = (left + width / 2 - text.width / 2).clamp(
        0.0,
        size.width - text.width,
      );
      text.paint(canvas, Offset(x, size.height - text.height));
    }
  }

  @override
  bool shouldRepaint(_BarChartPainter old) =>
      old.values != values ||
      old.bar != bar ||
      old.quietBar != quietBar ||
      old.labelColor != labelColor;
}

class _FilterBody extends StatefulWidget {
  const _FilterBody({
    required this.search,
    required this.status,
    required this.withStatus,
  });
  final String search;
  final String? status;
  final bool withStatus;

  @override
  State<_FilterBody> createState() => _FilterBodyState();
}

class _FilterBodyState extends State<_FilterBody> {
  late final _controller = TextEditingController(text: widget.search);
  late String? _status = widget.status;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSearchField(
          hint: widget.withStatus ? 'Search people' : 'Search changes',
          controller: _controller,
          onChanged: (_) => setState(() {}),
        ),
        if (widget.withStatus) ...[
          const SizedBox(height: 8),
          for (final (value, title) in const [
            (null, 'All sign-ins'),
            ('active', 'Active'),
            ('ended', 'Ended'),
          ])
            SheetOption(
              icon: value == 'active'
                  ? Icons.login_rounded
                  : value == 'ended'
                  ? Icons.logout_rounded
                  : Icons.people_outline_rounded,
              title: title,
              selected: _status == value,
              onTap: () => setState(() => _status = value),
            ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: () =>
              Navigator.pop(context, (_controller.text.trim(), _status)),
          child: const Text('Show results'),
        ),
        if (_controller.text.isNotEmpty || _status != null) ...[
          const SizedBox(height: 8),
          TextButton(
            onPressed: () => Navigator.pop(context, ('', null)),
            child: const Text('Clear filters'),
          ),
        ],
      ],
    );
  }
}

/// Label/value facts in a detail sheet.
class _DetailList extends StatelessWidget {
  const _DetailList({required this.facts});
  final List<(String, String?, Widget?)> facts;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (label, value, widget) in facts)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 96,
                  child: Text(
                    label,
                    style: TextStyle(color: colors.ink3, fontSize: 14),
                  ),
                ),
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child:
                        widget ??
                        Text(
                          value ?? '',
                          style: TextStyle(color: colors.ink, fontSize: 14.5),
                        ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
