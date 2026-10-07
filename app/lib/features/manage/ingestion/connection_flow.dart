import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import '../activity_page.dart';

String connectionName(JsonMap connection) => textOf(
  objectOf(connection['account'])['label'],
  textOf(connection['display_name'], 'Connected account'),
);

bool canManageConnection(BuildContext context, JsonMap connection) {
  final session = WorkspaceScope.of(context).session;
  return connection['owner_type'] == 'user'
      ? connection['owner_user_id'] == session.userId
      : session.can('source.manage');
}

Future<void> authorizeConnection(ApiClient api, JsonMap provider, {JsonMap? connection, String ownerType = 'workspace'}) async {
  final authorization = await api.post('/connections/authorizations', body: {
    'connector_key': provider['connector_key'],
    'owner_type': connection?['owner_type'] ?? ownerType,
    if (connection != null) 'connection_id': connection['id'],
  });
  final url = Uri.tryParse(textOf(authorization['authorization_url']));
  if (url == null || !await launchUrl(url, mode: LaunchMode.externalApplication)) {
    throw StateError('The provider sign-in could not be opened. Try again.');
  }
}

/// The provider callback remains server-owned. Returning from the browser never
/// implies success: the account list is re-read and only connected accounts proceed.
Future<JsonMap?> showConnectSourceSheet(BuildContext context, {String? collectionId}) =>
    showAppSheet<JsonMap>(context, title: 'Connect a source', scrollable: true,
      builder: (_) => _ConnectSource(collectionId: collectionId));

class _ConnectSource extends StatefulWidget {
  const _ConnectSource({this.collectionId});
  final String? collectionId;
  @override
  State<_ConnectSource> createState() => _ConnectSourceState();
}

class _ConnectSourceState extends State<_ConnectSource> {
  ApiClient? _api;
  List<JsonMap>? _providers;
  List<JsonMap> _accounts = [], _resources = [], _collections = [];
  JsonMap? _provider, _account, _resource;
  String? _destination;
  String _ownerType = 'user';
  final _parents = <JsonMap>[];
  final _name = TextEditingController();
  final _space = TextEditingController();
  final _page = TextEditingController();
  bool _recursive = false, _busy = false, _waiting = false;
  String? _error;
  int _step = 0;
  JsonMap? _schedule;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_api == null) {
      _api = WorkspaceScope.of(context).api;
      _ownerType = WorkspaceScope.of(context).session.can('source.manage') ? 'workspace' : 'user';
      _destination = widget.collectionId;
      _load();
    }
  }

  @override
  void dispose() {
    _name.dispose(); _space.dispose(); _page.dispose();
    super.dispose();
  }

  Future<void> _perform(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; });
    try { await action(); }
    catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _load() => _perform(() async {
    final providers = await _api!.get('/connections/providers');
    final collections = widget.collectionId == null
        ? await readAllPages(_api!, '/collections') : <JsonMap>[];
    if (!mounted) return;
    setState(() {
      _providers = objectList(providers['items']).where((p) => p['available'] == true && p['connector_key'] != 'file').toList();
      _collections = collections.where((c) => c['permissions'] is! List || (c['permissions'] as List).contains('collection.update')).toList();
    });
  });

  Future<void> _accountsFor(JsonMap provider) => _perform(() async {
    final accounts = await readAllPages(_api!, '/connections', query: {'connector_key': provider['connector_key']});
    if (!mounted) return;
    setState(() { _provider = provider; _accounts = accounts; _step = 1; });
  });

  Future<void> _authorize([JsonMap? connection]) => _perform(() async {
    await authorizeConnection(_api!, _provider!, connection: connection, ownerType: _ownerType);
    if (mounted) setState(() => _waiting = true);
  });

  Future<void> _credentials() async {
    final created = await showCredentialConnectionSheet(context, api: _api!, ownerType: _ownerType);
    if (!mounted || created == null) return;
    await _accountsFor(_provider!);
  }

  Future<void> _browse(JsonMap account, {String? parent}) => _perform(() async {
    final resources = account['browsable'] == true
        ? await _api!.get('/connections/${Uri.encodeComponent(textOf(account['id']))}/resources', query: {
            'connector_key': _provider!['connector_key'], 'parent_id': ?parent,
          }) : <String, dynamic>{};
    if (!mounted) return;
    setState(() { _account = account; _resources = objectList(resources['items']); _step = 2; });
  });

  Future<void> _create() => _perform(() async {
    final source = await _api!.post('/connections/${Uri.encodeComponent(textOf(_account!['id']))}/sources', body: {
      'collection_id': _destination,
      'display_name': _name.text.trim(),
      if (_resource != null) 'resource_type': _resource!['resource_type'],
      if (_resource != null) 'external_resource_id': _resource!['external_id'],
      if (_resource == null && _provider!['connector_key'] == 'confluence') 'config': {
        if (_space.text.trim().isNotEmpty) 'space': _space.text.trim(),
        if (_page.text.trim().isNotEmpty) 'page_id': _page.text.trim(),
        'index_recursively': _recursive,
      },
      if (_schedule != null) 'schedule': _schedule,
    });
    if (mounted) Navigator.pop(context, source);
  });

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(['Choose an app', 'Connect an account', 'Choose content', 'Destination and schedule'][_step], style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 12),
      if (_step > 0) Align(alignment: Alignment.centerLeft, child: TextButton.icon(
        onPressed: _busy ? null : () => setState(() { _step--; _error = null; }),
        icon: const Icon(Icons.arrow_back_rounded), label: const Text('Back'))),
      if (_providers == null && _busy) const LinearProgressIndicator(),
      if (_step == 0) ...[
        if (_providers?.isEmpty == true) const InlineNotice(text: 'No external connectors are available in this deployment.'),
        for (final provider in _providers ?? <JsonMap>[]) SheetOption(
          icon: Icons.power_outlined, title: textOf(provider['display_name']),
          subtitle: provider['authorization_available'] == true ? 'Sign in with your provider' : 'Connect with credentials',
          onTap: _busy ? null : () => _accountsFor(provider)),
      ],
      if (_step == 1) ...[
        if (WorkspaceScope.of(context).session.can('source.manage'))
          Segmented<String>(segments: const {'workspace': 'Workspace account', 'user': 'Personal account'}, selected: _ownerType, onChanged: (value) => setState(() => _ownerType = value)),
        if (_waiting) const InlineNotice(text: 'Finish sign-in in your browser, then refresh accounts. Only a confirmed account can continue.'),
        for (final account in _accounts) ListRow(
          title: connectionName(account), subtitle: sentenceCase(textOf(account['status'])),
          onTap: _busy ? null : account['status'] == 'connected'
              ? () { _parents.clear(); _resource = null; _browse(account); }
              : (_provider!['authorization_available'] == true && canManageConnection(context, account)) ? () => _authorize(account) : null,
          chevron: true),
        OutlinedButton.icon(onPressed: _busy ? null : () => _accountsFor(_provider!), icon: const Icon(Icons.refresh_rounded), label: const Text('Refresh accounts')),
        if (_provider!['authorization_available'] == true) FilledButton(
          onPressed: _busy ? null : () => _authorize(), child: Text('Sign in to ${textOf(_provider!['display_name'])}')),
        if (_provider!['connector_key'] == 'confluence' && _provider!['accepts_credentials'] == true) OutlinedButton(
          onPressed: _busy ? null : _credentials, child: const Text('Use an API token')),
      ],
      if (_step == 2) ...[
        if (_account!['browsable'] == true) ...[
          if (_parents.isNotEmpty) TextButton.icon(onPressed: _busy ? null : () {
            _parents.removeLast();
            _browse(_account!, parent: _parents.isEmpty ? null : textOf(_parents.last['external_id']));
          }, icon: const Icon(Icons.arrow_upward_rounded), label: Text('Back from ${textOf(_parents.last['name'])}')),
          if (_resources.isEmpty && !_busy) const InlineNotice(text: 'No content here. Go back to choose another folder or check the account’s access.'),
          for (final resource in _resources) ListRow(
            title: textOf(resource['name']), subtitle: sentenceCase(textOf(resource['resource_type'])),
            onTap: _busy ? null : () => setState(() { _resource = resource; _name.text = textOf(resource['name']); _step = 3; }),
            trailing: resource['has_children'] == true ? IconButton(tooltip: 'Browse ${textOf(resource['name'])}',
              onPressed: _busy ? null : () { _parents.add(resource); _browse(_account!, parent: textOf(resource['external_id'])); },
              icon: const Icon(Icons.chevron_right_rounded)) : null),
        ] else if (_provider!['connector_key'] == 'confluence') ...[
          const InlineNotice(text: 'Choose the Confluence scope. Leaving both fields empty reads the whole site.'),
          TextField(controller: _space, decoration: const InputDecoration(labelText: 'Space key (optional)')),
          TextField(controller: _page, decoration: const InputDecoration(labelText: 'Page ID (optional)')),
          SwitchListTile(title: const Text('Include child pages'), value: _recursive, onChanged: (v) => setState(() => _recursive = v)),
          FilledButton(onPressed: () => setState(() { _name.text = connectionName(_account!); _step = 3; }), child: const Text('Choose destination')),
        ] else const InlineNotice(text: 'This account cannot browse content. Check its access from Accounts.'),
      ],
      if (_step == 3) ...[
        TextField(controller: _name, decoration: const InputDecoration(labelText: 'Source name'), onChanged: (_) => setState(() {})),
        const SizedBox(height: 12),
        if (widget.collectionId == null) DropdownButtonFormField<String>(
          initialValue: _destination,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Knowledge base'),
          items: [for (final collection in _collections) DropdownMenuItem(value: textOf(collection['id']), child: Text(textOf(collection['title']), overflow: TextOverflow.ellipsis))],
          onChanged: _busy ? null : (id) => setState(() => _destination = id)),
        if (widget.collectionId == null && _collections.isEmpty) const InlineNotice(text: 'Create a knowledge base in Knowledge before connecting a source.'),
        const SizedBox(height: 12),
        SelectRow(label: 'Schedule', value: _schedule == null ? 'Manual sync' : 'Automatic sync and processing', onTap: () async {
          final schedule = await showScheduleEditor(context, initial: _schedule);
          if (mounted && schedule != null) setState(() => _schedule = schedule);
        }),
        if (_schedule != null) TextButton(onPressed: () => setState(() => _schedule = null), child: const Text('Use manual sync instead')),
        const SizedBox(height: 12),
        const InlineNotice(text: 'Connecting starts the first inventory sync. A schedule also processes changed documents; with manual sync, process waiting documents from source detail.'),
        FilledButton(onPressed: !_busy && _destination != null && _name.text.trim().isNotEmpty ? _create : null, child: const Text('Connect source')),
      ],
      if (_busy) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: LinearProgressIndicator()),
      if (_error != null) InlineNotice(text: _error!, tone: StatusTone.danger,
        actionLabel: _providers == null ? 'Try again' : null, onAction: _providers == null ? _load : null),
    ]);
  }
}

Future<JsonMap?> showCredentialConnectionSheet(BuildContext context, {required ApiClient api, JsonMap? connection, String ownerType = 'workspace'}) =>
  showAppSheet<JsonMap>(context, title: connection == null ? 'Connect Confluence' : 'Update Confluence credentials', scrollable: true,
    builder: (_) => _CredentialConnection(api: api, connection: connection, ownerType: ownerType));

class _CredentialConnection extends StatefulWidget {
  const _CredentialConnection({required this.api, this.connection, required this.ownerType});
  final ApiClient api;
  final JsonMap? connection;
  final String ownerType;
  @override
  State<_CredentialConnection> createState() => _CredentialConnectionState();
}

class _CredentialConnectionState extends State<_CredentialConnection> {
  final _site = TextEditingController(), _email = TextEditingController(), _token = TextEditingController();
  bool _cloud = true, _busy = false;
  String? _error;
  JsonMap? _created;
  @override
  void dispose() { _site.dispose(); _email.dispose(); _token.dispose(); super.dispose(); }
  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      final credentials = {'confluence_username': _email.text.trim(), 'confluence_access_token': _token.text.trim()};
      final existing = widget.connection ?? _created;
      final JsonMap connection;
      if (existing != null) {
        connection = await widget.api.patch('/connections/${Uri.encodeComponent(textOf(existing['id']))}', body: {'credentials': credentials});
      } else {
        final site = Uri.tryParse(_site.text.trim());
        if (site == null || site.host.isEmpty || !['http', 'https'].contains(site.scheme)) throw StateError('Enter the complete Confluence site URL.');
        connection = await widget.api.post('/connections', body: {
          'connector_key': 'confluence', 'display_name': site.host, 'owner_type': widget.ownerType,
          'config': {'wiki_base': _site.text.trim(), 'is_cloud': _cloud}, 'credentials': credentials,
        });
        _created = connection;
      }
      final validation = await widget.api.post('/connections/${Uri.encodeComponent(textOf(connection['id']))}/validate');
      if (validation['valid'] != true) throw StateError('Confluence did not accept these credentials. Check the account and token.');
      if (mounted) Navigator.pop(context, connection);
    } catch (error) { if (mounted) setState(() => _error = friendlyError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (widget.connection == null && _created == null) ...[
      TextField(controller: _site, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'Site URL', hintText: 'https://team.atlassian.net/wiki')),
      SwitchListTile(title: const Text('Atlassian Cloud'), value: _cloud, onChanged: _busy ? null : (v) => setState(() => _cloud = v)),
    ],
    TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Account email'), onChanged: (_) => setState(() {})),
    TextField(controller: _token, obscureText: true, enableSuggestions: false, autocorrect: false, decoration: const InputDecoration(labelText: 'API token'), onChanged: (_) => setState(() {})),
    const SizedBox(height: 12),
    const InlineNotice(text: 'Credentials are stored encrypted by the server and never displayed again.'),
    if (_error != null) InlineNotice(text: _error!, tone: StatusTone.danger),
    FilledButton(onPressed: !_busy && _email.text.trim().isNotEmpty && _token.text.trim().isNotEmpty ? _save : null, child: Text(_busy ? 'Checking account…' : 'Save and validate')),
  ]);
}

Future<JsonMap?> showScheduleEditor(BuildContext context, {JsonMap? initial}) =>
  showAppSheet<JsonMap>(context, title: 'Sync schedule', scrollable: true, builder: (_) => _ScheduleEditor(initial: initial));

class _ScheduleEditor extends StatefulWidget {
  const _ScheduleEditor({this.initial});
  final JsonMap? initial;
  @override
  State<_ScheduleEditor> createState() => _ScheduleEditorState();
}
class _ScheduleEditorState extends State<_ScheduleEditor> {
  late final _cron = TextEditingController(text: textOf(widget.initial?['cron_expression'], '0 6 * * *'));
  late final _zone = TextEditingController(text: textOf(widget.initial?['timezone'], localTimeZone()));
  late bool _enabled = widget.initial?['enabled'] != false;
  late String _overlap = textOf(widget.initial?['overlap_policy'], 'skip');
  @override
  void dispose() { _cron.dispose(); _zone.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    const InlineNotice(text: 'Each scheduled sync checks the provider and processes new or changed documents.'),
    DropdownButtonFormField<String>(initialValue: null, decoration: const InputDecoration(labelText: 'Quick schedule'),
      items: const [DropdownMenuItem(value: '0 * * * *', child: Text('Every hour')), DropdownMenuItem(value: '0 6 * * *', child: Text('Daily at 06:00')), DropdownMenuItem(value: '0 6 * * 1', child: Text('Monday at 06:00'))],
      onChanged: (v) { if (v != null) setState(() => _cron.text = v); }),
    TextField(controller: _cron, decoration: const InputDecoration(labelText: 'Cron expression', helperText: 'Minute · hour · day · month · weekday'), onChanged: (_) => setState(() {})),
    TextField(controller: _zone, decoration: const InputDecoration(labelText: 'Time zone', helperText: 'IANA name, for example Asia/Ho_Chi_Minh')),
    DropdownButtonFormField<String>(initialValue: _overlap, decoration: const InputDecoration(labelText: 'If a previous sync is still running'),
      items: const [DropdownMenuItem(value: 'skip', child: Text('Skip this occurrence')), DropdownMenuItem(value: 'queue', child: Text('Queue the next sync')), DropdownMenuItem(value: 'replace', child: Text('Replace the running sync'))], onChanged: (v) => setState(() => _overlap = v!)),
    SwitchListTile(title: const Text('Schedule enabled'), value: _enabled, onChanged: (v) => setState(() => _enabled = v)),
    FilledButton(onPressed: _cron.text.trim().isEmpty ? null : () => Navigator.pop(context, <String, dynamic>{
      'schedule_type': 'cron', 'cron_expression': _cron.text.trim(), 'timezone': _zone.text.trim().isEmpty ? null : _zone.text.trim(), 'enabled': _enabled, 'overlap_policy': _overlap,
    }), child: const Text('Use schedule')),
  ]);
}

class ConnectionAccounts extends StatefulWidget {
  const ConnectionAccounts({super.key});
  @override
  State<ConnectionAccounts> createState() => _ConnectionAccountsState();
}
class _ConnectionAccountsState extends State<ConnectionAccounts> {
  ApiClient? _api;
  List<JsonMap>? _accounts;
  Object? _error;
  @override
  void didChangeDependencies() { super.didChangeDependencies(); if (_api == null) { _api = WorkspaceScope.of(context).api; _load(); } }
  Future<void> _load() async {
    try { final accounts = await readAllPages(_api!, '/connections'); if (mounted) setState(() { _accounts = accounts; _error = null; }); }
    catch (e) { if (mounted) setState(() => _error = e); }
  }
  @override
  Widget build(BuildContext context) {
    if (_accounts == null) return _error == null ? const LoadingView() : ErrorView(error: _error!, onRetry: _load);
    return RefreshIndicator(onRefresh: _load, child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: kPagePadding, children: [
      if (_error != null) InlineNotice(text: friendlyError(_error!), tone: StatusTone.danger),
      if (_accounts!.isEmpty) const EmptyView(icon: Icons.power_outlined, title: 'No connected accounts', message: 'Connect a source to authorize an account.'),
      for (final account in _accounts!) ListRow(title: connectionName(account), subtitle: '${sentenceCase(textOf(account['connector_key']))} · ${countOf(intOf(account['source_count']), 'source')}',
        trailing: StatusPill(label: sentenceCase(textOf(account['status'])), tone: account['status'] == 'connected' ? StatusTone.success : StatusTone.danger),
        onTap: () async { await showConnectionSheet(context, api: _api!, connection: account); if (mounted) _load(); }),
    ]));
  }
}

Future<void> showConnectionSheet(BuildContext context, {required ApiClient api, required JsonMap connection}) =>
  showAppSheet<void>(context, title: connectionName(connection), scrollable: true, builder: (_) => _ConnectionDetail(api: api, connection: connection));

class _ConnectionDetail extends StatefulWidget {
  const _ConnectionDetail({required this.api, required this.connection});
  final ApiClient api;
  final JsonMap connection;
  @override
  State<_ConnectionDetail> createState() => _ConnectionDetailState();
}
class _ConnectionDetailState extends State<_ConnectionDetail> {
  late JsonMap _connection = widget.connection;
  List<JsonMap>? _sources;
  JsonMap? _provider;
  bool _busy = false;
  String? _error;
  String get _path => '/connections/${Uri.encodeComponent(textOf(_connection['id']))}';
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _act(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; });
    try { await action(); } catch (e) { if (mounted) setState(() => _error = friendlyError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _load() => _act(() async {
    final connection = await widget.api.get(_path);
    final sources = await readAllPages(widget.api, '/sources', query: {'connection_id': _connection['id']});
    final providers = objectList((await widget.api.get('/connections/providers'))['items']);
    if (mounted) setState(() { _connection = connection; _sources = sources; _provider = providers.where((p) => p['connector_key'] == connection['connector_key']).firstOrNull; });
  });
  @override
  Widget build(BuildContext context) {
    final canManage = canManageConnection(context, _connection);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SelectRow(label: 'Account status', value: sentenceCase(textOf(_connection['status']))),
      if (textOf(_connection['status_detail']).isNotEmpty) InlineNotice(text: textOf(_connection['status_detail'])),
      if (_busy) const LinearProgressIndicator(),
      if (_error != null) InlineNotice(text: _error!, tone: StatusTone.danger),
      const SectionLabel('Sources using this account', first: true),
      for (final source in _sources ?? <JsonMap>[]) ListRow(title: textOf(source['display_name'], 'Source'), subtitle: sentenceCase(textOf(source['status']))),
      if (_sources?.isEmpty == true) const InlineNotice(text: 'No sources use this account.'),
      OutlinedButton(onPressed: _busy ? null : _load, child: const Text('Refresh account')),
      if (canManage) ...[
        if (_provider?['authorization_available'] == true) FilledButton(onPressed: _busy ? null : () => _act(() async {
          await authorizeConnection(widget.api, _provider!, connection: _connection);
          if (context.mounted) showToast(context, 'Finish sign-in in your browser, then refresh this account');
        }), child: const Text('Reconnect account')),
        if (_connection['connector_key'] == 'confluence' && _provider?['accepts_credentials'] == true) OutlinedButton(onPressed: _busy ? null : () async {
          await showCredentialConnectionSheet(context, api: widget.api, connection: _connection);
          if (mounted) _load();
        }, child: const Text('Update API token')),
        OutlinedButton(onPressed: _busy ? null : () => _act(() async {
          final result = await widget.api.post('$_path/validate');
          if (result['valid'] != true) throw StateError('The account could not be validated. Reconnect it and try again.');
          final updated = await widget.api.get(_path);
          if (mounted) setState(() => _connection = updated);
        }), child: const Text('Check account access')),
        if (_sources?.isEmpty == true) TextButton(onPressed: _busy ? null : () async {
          final confirmed = await confirmAction(context, title: 'Disconnect account?', message: 'This removes the saved connection. You can connect it again later.', confirmLabel: 'Disconnect', destructive: true);
          if (!confirmed || !mounted) return;
          await _act(() async { await widget.api.delete(_path); if (context.mounted) Navigator.pop(context); });
        }, child: const Text('Disconnect account')),
      ],
    ]);
  }
}
