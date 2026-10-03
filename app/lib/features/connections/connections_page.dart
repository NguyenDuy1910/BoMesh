import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'connection_forms.dart';
import 'connection_models.dart';
import 'connection_widgets.dart';
import 'ingestion_activity_page.dart';

class ConnectionsPage extends StatefulWidget {
  const ConnectionsPage({super.key, required this.api, required this.session});
  final ApiClient api;
  final AuthSession session;
  @override
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage> {
  final _search = TextEditingController();
  List<ConnectionRecord> _connections = [];
  List<SourceRecord> _sources = [];
  List<ProviderInfo> _providers = [];
  bool _busy = false, _sourceTab = false;
  int _page = 1, _total = 0, _generation = 0;
  String? _error, _providerError;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_loadProviders());
  }

  @override
  void dispose() {
    _generation++;
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadProviders() async {
    try {
      final result = await widget.api.get('/connections/providers');
      if (mounted) {
        setState(() {
          _providers = objectList(result['items'])
              .map(ProviderInfo.new)
              .toList();
          _providerError = null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _providerError = '$error');
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    final sourceTab = _sourceTab;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.get(
        sourceTab ? '/sources' : '/connections',
        query: {
          'page': _page,
          'page_size': 20,
          if (!sourceTab && _search.text.trim().isNotEmpty)
            'search': _search.text.trim(),
        },
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _total = countOf(result['total']);
        if (sourceTab) {
          _sources = objectList(result['items']).map(SourceRecord.new).toList();
        } else {
          _connections = objectList(result['items'])
              .map(ConnectionRecord.new)
              .toList();
        }
      });
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _openConnection(ConnectionRecord connection) async {
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ConnectionDetailPage(
          api: widget.api,
          session: widget.session,
          connectionId: connection.id,
          providers: _providers,
        ),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _openSource(SourceRecord source) async {
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SourceDetailPage(
          api: widget.api,
          session: widget.session,
          sourceId: source.id,
        ),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _addConnection() async {
    final provider = await Navigator.push<ProviderInfo>(
      context,
      MaterialPageRoute(builder: (_) => _ProviderPickerPage(api: widget.api)),
    );
    if (!mounted || provider == null) return;
    final connection = await Navigator.push<ConnectionRecord>(
      context,
      MaterialPageRoute(
        builder: (_) => ConnectionEditorPage(
          api: widget.api,
          session: widget.session,
          provider: provider,
        ),
      ),
    );
    if (!mounted) return;
    await _load();
    if (mounted && connection != null) await _openConnection(connection);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Connections'),
      actions: [
        IconButton(
          tooltip: 'Refresh connections',
          onPressed: _busy
              ? null
              : () {
                  unawaited(_load());
                  unawaited(_loadProviders());
                },
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: _addConnection,
      icon: const Icon(Icons.add),
      label: const Text('Connect account'),
    ),
    body: IntegrationBody(
      onRefresh: _load,
      children: [
        Text(
          'Knowledge, connected.',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          'Manage the accounts and sources feeding ${widget.session.workspaceName}.',
          style: TextStyle(color: context.colors.textSecondary),
        ),
        const SizedBox(height: 24),
        SegmentedButton<bool>(
          segments: const [
            ButtonSegment(
              value: false,
              label: Text('Accounts'),
              icon: Icon(Icons.link),
            ),
            ButtonSegment(
              value: true,
              label: Text('Sources'),
              icon: Icon(Icons.folder_copy_outlined),
            ),
          ],
          selected: {_sourceTab},
          onSelectionChanged: (value) {
            setState(() {
              _sourceTab = value.single;
              _page = 1;
              _connections = [];
              _sources = [];
            });
            unawaited(_load());
          },
        ),
        const SizedBox(height: 20),
        if (!_sourceTab) ...[
          TextField(
            controller: _search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) {
              _page = 1;
              unawaited(_load());
            },
            decoration: InputDecoration(
              labelText: 'Search accounts',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: IconButton(
                tooltip: 'Search accounts',
                onPressed: _busy
                    ? null
                    : () {
                        _page = 1;
                        unawaited(_load());
                      },
                icon: const Icon(Icons.arrow_forward),
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (_error != null)
          IntegrationNotice(message: _error!, error: true, onRetry: _load),
        if (_providerError != null)
          IntegrationNotice(
            message:
                'Provider information could not be loaded. $_providerError',
            error: true,
            onRetry: _loadProviders,
          ),
        if (_busy)
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: LinearProgressIndicator(),
          ),
        if (!_busy &&
            _error == null &&
            (_sourceTab ? _sources.isEmpty : _connections.isEmpty))
          IntegrationEmpty(
            title: _sourceTab
                ? 'No knowledge sources yet'
                : 'No connected accounts',
            message: _sourceTab
                ? 'Open an account and choose the content to bring into a collection.'
                : 'Connect an account, then choose what belongs in your workspace.',
          ),
        if (_sourceTab)
          for (final source in _sources)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: IntegrationCard(
                padding: EdgeInsets.zero,
                child: ListTile(
                  contentPadding: const EdgeInsets.all(16),
                  title: Text(source.name),
                  subtitle: Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        StatusBadge(source.status),
                        const SizedBox(height: 8),
                        Text(scheduleLabel(source.schedule)),
                      ],
                    ),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openSource(source),
                ),
              ),
            )
        else
          for (final connection in _connections)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: IntegrationCard(
                padding: EdgeInsets.zero,
                child: ListTile(
                  contentPadding: const EdgeInsets.all(16),
                  leading: CircleAvatar(
                    backgroundColor: context.colors.brandSoft,
                    child: Icon(
                      Icons.hub_outlined,
                      color: context.colors.brand,
                    ),
                  ),
                  title: Text(
                    connection.name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  subtitle: Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (connection.accountLine.isNotEmpty)
                          Text(connection.accountLine),
                        const SizedBox(height: 8),
                        StatusBadge(connection.status),
                        const SizedBox(height: 8),
                        Text(
                          '${connection.sourceCount} sources · ${connection.ownerType == 'workspace' ? 'Shared' : 'Personal'}',
                        ),
                      ],
                    ),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openConnection(connection),
                ),
              ),
            ),
        IntegrationPager(
          page: _page,
          total: _total,
          pageSize: 20,
          busy: _busy,
          onPage: (page) {
            _page = page;
            unawaited(_load());
          },
        ),
        const SizedBox(height: 80),
      ],
    ),
  );
}

class _ProviderPickerPage extends StatefulWidget {
  const _ProviderPickerPage({required this.api});
  final ApiClient api;
  @override
  State<_ProviderPickerPage> createState() => _ProviderPickerPageState();
}

class _ProviderPickerPageState extends State<_ProviderPickerPage> {
  List<ProviderInfo> _providers = [];
  bool _busy = true;
  String? _error;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.get('/connections/providers');
      if (mounted) {
        setState(
          () =>
              _providers = objectList(result['items'])
                  .map(ProviderInfo.new)
                  .toList(),
        );
      }
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Choose a provider')),
    body: IntegrationBody(
      onRefresh: _load,
      children: [
        const Text('Only providers registered in this deployment appear here.'),
        const SizedBox(height: 20),
        if (_error != null)
          IntegrationNotice(message: _error!, error: true, onRetry: _load),
        if (_busy) const LinearProgressIndicator(),
        if (!_busy && _providers.isEmpty && _error == null)
          const IntegrationEmpty(
            title: 'No providers configured',
            message: 'Ask your workspace administrator to configure a supported connector.',
          ),
        for (final provider in _providers)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: IntegrationCard(
              padding: EdgeInsets.zero,
              child: ListTile(
                contentPadding: const EdgeInsets.all(20),
                leading: const Icon(Icons.hub_outlined),
                title: Text(provider.name),
                subtitle: Text(
                  !provider.available
                      ? 'Authorization is not configured for this deployment.'
                      : provider.canAuthorize
                      ? 'Sign in with ${provider.providerName}${provider.hasCredentialForm ? ' or use an API token' : ''}'
                      : provider.hasCredentialForm
                      ? 'Connect with an API token'
                      : provider.authentication == 'none'
                      ? 'No credentials required'
                      : 'Credential setup is not described by this provider.',
                ),
                trailing:
                    provider.available &&
                        (provider.canAuthorize ||
                            provider.hasCredentialForm ||
                            provider.authentication == 'none')
                    ? const Icon(Icons.chevron_right)
                    : null,
                onTap:
                    provider.available &&
                        (provider.canAuthorize ||
                            provider.hasCredentialForm ||
                            provider.authentication == 'none')
                    ? () => Navigator.pop(context, provider)
                    : null,
              ),
            ),
          ),
      ],
    ),
  );
}

class ConnectionDetailPage extends StatefulWidget {
  const ConnectionDetailPage({
    super.key,
    required this.api,
    required this.session,
    required this.connectionId,
    this.providers = const [],
  });
  final ApiClient api;
  final AuthSession session;
  final String connectionId;
  final List<ProviderInfo> providers;
  @override
  State<ConnectionDetailPage> createState() => _ConnectionDetailPageState();
}

class _ConnectionDetailPageState extends State<ConnectionDetailPage> {
  ConnectionRecord? _connection;
  List<SourceRecord> _sources = [];
  bool _loading = true, _busy = false;
  int _page = 1, _total = 0, _generation = 0;
  String? _error;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _generation++;
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        widget.api.get(resourcePath('connections', widget.connectionId)),
        widget.api.get(
          '/sources',
          query: {
            'connection_id': widget.connectionId,
            'page': _page,
            'page_size': 20,
          },
        ),
      ]);
      if (mounted && generation == _generation) {
        setState(() {
          _connection = ConnectionRecord(results[0]);
          _sources = objectList(results[1]['items'])
              .map(SourceRecord.new)
              .toList();
          _total = countOf(results[1]['total']);
        });
      }
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _action(Future<void> Function() action, String message) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      if (!mounted) return;
      integrationToast(context, message);
      await _load();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit() async {
    if (_connection == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      var providers = widget.providers;
      if (!providers.any(
        (provider) => provider.key == _connection!.connector,
      )) {
        providers = objectList(
          (await widget.api.get('/connections/providers'))['items'],
        ).map(ProviderInfo.new).toList();
      }
      if (!mounted) return;
      final provider = providers
          .where((provider) => provider.key == _connection!.connector)
          .firstOrNull;
      if (provider == null) {
        throw StateError(
          'This connector is no longer registered. Restore it before editing this account.',
        );
      }
      await Navigator.push(
        context,
        MaterialPageRoute<ConnectionRecord>(
          builder: (_) => ConnectionEditorPage(
            api: widget.api,
            session: widget.session,
            provider: provider,
            connection: _connection,
          ),
        ),
      );
      if (mounted) await _load();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    if (!await confirmIntegration(
          context,
          title: 'Delete this connection?',
          message: 'This removes the account from this workspace and stops its sources. This cannot be undone.',
          action: 'Delete connection',
        ) ||
        !mounted) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.delete(resourcePath('connections', widget.connectionId));
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addSource() async {
    await Navigator.push(
      context,
      MaterialPageRoute<bool>(
        builder: (_) => SourceEditorPage(
          api: widget.api,
          session: widget.session,
          connection: _connection!,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final connection = _connection;
    final writable = connection?.writable(widget.session) ?? false;
    return Scaffold(
      appBar: AppBar(
        title: Text(connection?.name ?? 'Connection'),
        actions: [
          IconButton(
            tooltip: 'Refresh connection',
            onPressed: _loading || _busy ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: IntegrationBody(
        onRefresh: _load,
        children: [
          if (_error != null)
            IntegrationNotice(message: _error!, error: true, onRetry: _load),
          if (_loading || _busy)
            const Padding(
              padding: EdgeInsets.only(bottom: 16),
              child: LinearProgressIndicator(),
            ),
          if (connection != null) ...[
            IntegrationCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    connection.name,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 12),
                  StatusBadge(connection.status),
                  if (connection.statusDetail.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(connection.statusDetail),
                    ),
                  DetailLine('Account', connection.accountLine),
                  DetailLine(
                    'Ownership',
                    connection.ownerType == 'workspace'
                        ? 'Shared workspace connection'
                        : 'Personal connection',
                  ),
                  DetailLine('Connected', dateLabel(connection.connectedAt)),
                  DetailLine('Last checked', dateLabel(connection.checkedAt)),
                  if (writable)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        OutlinedButton.icon(
                          onPressed: _busy ? null : _edit,
                          icon: const Icon(Icons.edit_outlined),
                          label: const Text('Edit / reconnect'),
                        ),
                        OutlinedButton.icon(
                          onPressed: _busy
                              ? null
                              : () => _action(() async {
                                  final result = await widget.api.post(
                                    '${resourcePath('connections', connection.id)}/validate',
                                  );
                                  if (result['valid'] != true) {
                                    throw StateError(
                                      'Validation failed: ${readable(textOf(result['status']))}',
                                    );
                                  }
                                }, 'Connection verified'),
                          icon: const Icon(Icons.verified_user_outlined),
                          label: const Text('Validate'),
                        ),
                        if (connection.status != 'disconnected')
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () async {
                                    if (await confirmIntegration(
                                          context,
                                          title: 'Disconnect this account?',
                                          message: 'Its sources stay in place but stop syncing. Reconnect the same account to use them again.',
                                          action: 'Disconnect',
                                        ) &&
                                        mounted) {
                                      await _action(() async {
                                        await widget.api.patch(
                                          resourcePath(
                                            'connections',
                                            connection.id,
                                          ),
                                          body: {'status': 'disconnected'},
                                        );
                                      }, 'Account disconnected');
                                    }
                                  },
                            child: const Text('Disconnect'),
                          ),
                        TextButton(
                          onPressed: _busy ? null : _delete,
                          child: Text(
                            'Delete',
                            style: TextStyle(color: context.colors.danger),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Knowledge sources',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            if (writable && connection.status == 'connected')
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: FilledButton.icon(
                  onPressed: _busy ? null : _addSource,
                  icon: const Icon(Icons.add),
                  label: const Text('Add knowledge source'),
                ),
              ),
            if (connection.status != 'connected')
              const IntegrationNotice(
                message: 'Validate or reconnect this account before adding knowledge sources.',
              ),
            if (_sources.isEmpty && !_loading)
              const IntegrationEmpty(
                title: 'Choose what belongs here',
                message:
                    'Add a source to sync provider content into a collection.',
              ),
            for (final source in _sources)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: IntegrationCard(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    contentPadding: const EdgeInsets.all(16),
                    title: Text(source.name),
                    subtitle: Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          StatusBadge(source.status),
                          const SizedBox(height: 8),
                          Text(scheduleLabel(source.schedule)),
                        ],
                      ),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () async {
                      await Navigator.push(
                        context,
                        MaterialPageRoute<void>(
                          builder: (_) => SourceDetailPage(
                            api: widget.api,
                            session: widget.session,
                            sourceId: source.id,
                          ),
                        ),
                      );
                      if (mounted) await _load();
                    },
                  ),
                ),
              ),
            IntegrationPager(
              page: _page,
              total: _total,
              pageSize: 20,
              busy: _loading,
              onPage: (page) {
                _page = page;
                unawaited(_load());
              },
            ),
          ],
        ],
      ),
    );
  }
}

class SourceDetailPage extends StatefulWidget {
  const SourceDetailPage({
    super.key,
    required this.api,
    required this.session,
    required this.sourceId,
  });
  final ApiClient api;
  final AuthSession session;
  final String sourceId;
  @override
  State<SourceDetailPage> createState() => _SourceDetailPageState();
}

class _SourceDetailPageState extends State<SourceDetailPage>
    with WidgetsBindingObserver, IntegrationPolling<SourceDetailPage> {
  SourceRecord? _source;
  ConnectionRecord? _connection;
  IngestionRecord? _latest;
  List<IngestionRecord> _runs = [];
  String? _error, _statusError;
  String _destination = '';
  bool _loading = false, _busy = false;
  int _page = 1, _total = 0, _generation = 0;
  bool get _canActivity => widget.session.can('source.manage');
  bool get _writable => _connection?.writable(widget.session) ?? false;
  @override
  Duration get pollingInterval => _latest?.active == true
      ? const Duration(seconds: 2)
      : const Duration(seconds: 15);
  @override
  bool get pollingEnabled => _canActivity && !_busy;
  @override
  Future<void> poll() => _load(silent: true);
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    startPolling();
  }

  @override
  void dispose() {
    _generation++;
    stopPolling();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (silent && (_loading || _busy)) return;
    final generation = ++_generation;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final source = SourceRecord(
        await widget.api.get(resourcePath('sources', widget.sourceId)),
      );
      if (!mounted || generation != _generation) return;
      final connection = ConnectionRecord(
        await widget.api.get(resourcePath('connections', source.connectionId)),
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _source = source;
        _connection = connection;
        _error = null;
      });
      if (_destination.isEmpty) {
        try {
          final collection = await widget.api.get(
            resourcePath('collections', source.collectionId),
          );
          if (mounted && generation == _generation) {
            setState(
              () => _destination = textOf(
                collection['title'],
                source.collectionId,
              ),
            );
          }
        } on ApiException catch (error) {
          if (error.status != 403 && error.status != 404) rethrow;
          if (mounted && generation == _generation) {
            setState(() => _destination = source.collectionId);
          }
        }
      }
      if (_canActivity) {
        try {
          final result = await Future.wait([
            widget.api.get(
              '${resourcePath('sources', widget.sourceId)}/status',
            ),
            widget.api.get(
              '${resourcePath('sources', widget.sourceId)}/ingestions',
              query: {'page': _page, 'page_size': 10},
            ),
          ]);
          if (!mounted || generation != _generation) return;
          setState(() {
            _latest = result[0]['latest_ingestion'] is Map
                ? IngestionRecord(objectOf(result[0]['latest_ingestion']))
                : null;
            _runs = objectList(result[1]['items'])
                .map(IngestionRecord.new)
                .toList();
            _total = countOf(result[1]['total']);
            _statusError = null;
          });
        } catch (error) {
          if (mounted && generation == _generation) {
            setState(() => _statusError = '$error');
          }
        }
      }
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
        schedulePoll();
      }
    }
  }

  Future<void> _action(Future<void> Function() action, String message) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      if (!mounted) return;
      integrationToast(context, message);
      await _load();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        schedulePoll();
      }
    }
  }

  Future<void> _sync() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final run = IngestionRecord(
        await widget.api.post(
          '${resourcePath('sources', widget.sourceId)}/ingestions',
        ),
      );
      if (!mounted) return;
      if (_canActivity) {
        await Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (_) => IngestionDetailPage(
              api: widget.api,
              session: widget.session,
              ingestionId: run.id,
            ),
          ),
        );
      } else {
        integrationToast(
          context,
          'Sync started. Source activity requires workspace source-management access.',
        );
      }
      if (mounted) await _load();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        schedulePoll();
      }
    }
  }

  Future<void> _schedule() async {
    await Navigator.push(
      context,
      MaterialPageRoute<bool>(
        builder: (_) => ScheduleEditorPage(
          api: widget.api,
          sourceId: widget.sourceId,
          schedule: _source!.schedule,
        ),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _delete() async {
    if (!await confirmIntegration(
          context,
          title: 'Remove this source?',
          message: 'This stops future syncing and removes its schedule. Existing collection documents are not deleted by this action.',
          action: 'Remove source',
        ) ||
        !mounted) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.delete(resourcePath('sources', widget.sourceId));
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final source = _source;
    final schedule = source?.schedule;
    return Scaffold(
      appBar: AppBar(
        title: Text(source?.name ?? 'Knowledge source'),
        actions: [
          IconButton(
            tooltip: 'Refresh source',
            onPressed: _loading || _busy ? null : () => _load(),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: IntegrationBody(
        onRefresh: _load,
        children: [
          if (_error != null)
            IntegrationNotice(
              message: _error!,
              error: true,
              onRetry: () => _load(),
            ),
          if (_loading || _busy)
            const Padding(
              padding: EdgeInsets.only(bottom: 16),
              child: LinearProgressIndicator(),
            ),
          if (source != null) ...[
            IntegrationCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    source.name,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 12),
                  StatusBadge(source.status),
                  DetailLine(
                    'Account',
                    _connection?.name ?? source.connectionId,
                  ),
                  DetailLine(
                    'Destination collection',
                    _destination.isEmpty ? source.collectionId : _destination,
                  ),
                  if (source.resourceType.isNotEmpty)
                    DetailLine('Content type', readable(source.resourceType)),
                  if (source.resourceId.isNotEmpty)
                    DetailLine('Provider resource', source.resourceId),
                  if (_writable)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        FilledButton.icon(
                          onPressed:
                              _busy ||
                                  _latest?.active == true ||
                                  _connection?.status != 'connected' ||
                                  !const {
                                    'ready',
                                    'failed',
                                  }.contains(source.status)
                              ? null
                              : _sync,
                          icon: const Icon(Icons.sync),
                          label: Text(
                            _latest?.active == true
                                ? 'Sync in progress'
                                : 'Sync now',
                          ),
                        ),
                        OutlinedButton.icon(
                          onPressed: _busy
                              ? null
                              : () async {
                                  await Navigator.push(
                                    context,
                                    MaterialPageRoute<bool>(
                                      builder: (_) => SourceEditorPage(
                                        api: widget.api,
                                        session: widget.session,
                                        connection: _connection!,
                                        source: source,
                                      ),
                                    ),
                                  );
                                  if (mounted) await _load();
                                },
                          icon: const Icon(Icons.edit_outlined),
                          label: const Text('Edit'),
                        ),
                        if (source.status != 'connection_required')
                          OutlinedButton(
                            onPressed: _busy
                                ? null
                                : () => _action(
                                    () async {
                                      await widget.api.patch(
                                        resourcePath('sources', source.id),
                                        body: {
                                          'status':
                                              source.status == 'paused' ||
                                                  source.status == 'disabled'
                                              ? 'ready'
                                              : 'paused',
                                        },
                                      );
                                    },
                                    source.status == 'paused' ||
                                            source.status == 'disabled'
                                        ? 'Source resumed'
                                        : 'Source paused',
                                  ),
                            child: Text(
                              source.status == 'paused' ||
                                      source.status == 'disabled'
                                  ? 'Resume source'
                                  : 'Pause source',
                            ),
                          ),
                        if (source.status != 'disabled' &&
                            source.status != 'connection_required')
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () async {
                                    if (await confirmIntegration(
                                          context,
                                          title: 'Disable this source?',
                                          message: 'The source will stop accepting syncs. You can enable it again from this page.',
                                          action: 'Disable',
                                        ) &&
                                        mounted) {
                                      await _action(() async {
                                        await widget.api.patch(
                                          resourcePath('sources', source.id),
                                          body: {'status': 'disabled'},
                                        );
                                      }, 'Source disabled');
                                    }
                                  },
                            child: const Text('Disable'),
                          ),
                        TextButton(
                          onPressed: _busy ? null : _delete,
                          child: Text(
                            'Remove',
                            style: TextStyle(color: context.colors.danger),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            IntegrationCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Sync schedule',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 12),
                  Text(scheduleLabel(schedule)),
                  if (schedule != null) ...[
                    DetailLine(
                      'Time zone',
                      textOf(schedule['timezone'], 'UTC'),
                    ),
                    DetailLine('Next run', dateLabel(schedule['next_run_at'])),
                    DetailLine('Last run', dateLabel(schedule['last_run_at'])),
                    DetailLine(
                      'Overlapping syncs',
                      readable(textOf(schedule['overlap_policy'])),
                    ),
                  ],
                  if (_writable)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        OutlinedButton.icon(
                          onPressed: _busy ? null : _schedule,
                          icon: const Icon(Icons.schedule),
                          label: Text(
                            schedule == null ? 'Add schedule' : 'Edit schedule',
                          ),
                        ),
                        if (schedule != null) ...[
                          OutlinedButton(
                            onPressed: _busy
                                ? null
                                : () => _action(
                                    () async {
                                      await widget.api.patch(
                                        '${resourcePath('sources', source.id)}/schedule',
                                        body: {
                                          'enabled':
                                              schedule['enabled'] != true,
                                        },
                                      );
                                    },
                                    schedule['enabled'] == true
                                        ? 'Schedule paused'
                                        : 'Schedule resumed',
                                  ),
                            child: Text(
                              schedule['enabled'] == true
                                  ? 'Pause schedule'
                                  : 'Resume schedule',
                            ),
                          ),
                          TextButton(
                            onPressed: _busy
                                ? null
                                : () async {
                                    if (await confirmIntegration(
                                          context,
                                          title: 'Remove sync schedule?',
                                          message: 'The source will run only when you choose Sync now.',
                                          action: 'Remove schedule',
                                        ) &&
                                        mounted) {
                                      await _action(
                                        () => widget.api.delete(
                                          '${resourcePath('sources', source.id)}/schedule',
                                        ),
                                        'Schedule removed',
                                      );
                                    }
                                  },
                            child: const Text('Remove schedule'),
                          ),
                        ],
                      ],
                    ),
                ],
              ),
            ),
            if (_canActivity) ...[
              const SizedBox(height: 24),
              Text(
                'Sync history',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              if (_statusError != null)
                IntegrationNotice(
                  message: _statusError!,
                  error: true,
                  onRetry: () => _load(),
                ),
              if (_runs.isEmpty && !_loading && _statusError == null)
                const IntegrationEmpty(
                  title: 'No syncs yet',
                  message: 'Choose Sync now to start bringing this source into knowledge.',
                  icon: Icons.history,
                ),
              for (final run in _runs)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: IngestionTile(
                    ingestion: run,
                    onTap: () async {
                      await Navigator.push(
                        context,
                        MaterialPageRoute<void>(
                          builder: (_) => IngestionDetailPage(
                            api: widget.api,
                            session: widget.session,
                            ingestionId: run.id,
                          ),
                        ),
                      );
                      if (mounted) await _load();
                    },
                  ),
                ),
              IntegrationPager(
                page: _page,
                total: _total,
                pageSize: 10,
                busy: _loading,
                onPage: (page) {
                  _page = page;
                  unawaited(_load());
                },
              ),
            ] else
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: IntegrationNotice(
                  message: 'Detailed source activity is visible to members with source-management permission.',
                ),
              ),
          ],
        ],
      ),
    );
  }
}
