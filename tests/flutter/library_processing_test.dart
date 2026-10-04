import 'dart:convert';

import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/knowledge/document_list.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, Object?> document(String id, String state, {String? error}) => {
  'id': id,
  'collection_id': 'collection',
  'name': '$id.pdf',
  'content_type': 'application/pdf',
  'size_bytes': 10,
  'purpose': 'knowledge',
  'status': 'available',
  'processing': {'state': state, 'error': error, 'run_id': null},
  'created_at': '2026-10-01T00:00:00Z',
  'updated_at': '2026-10-01T00:00:00Z',
};

/// A fake API: the documents' states, every run request's body, and the
/// answers to give run creation and run reads, in order.
class FakeLibrary {
  FakeLibrary({required this.created, this.runStatuses = const []});
  final List<http.Response> created;
  final List<String> runStatuses;
  final runBodies = <Object?>[];
  var documentReads = 0, runReads = 0;
  var states = {'pending': 'pending', 'failed': 'failed'};

  late final api = ApiClient(
    baseUrl: 'http://api.test',
    client: MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/documents')) {
        documentReads++;
        return http.Response(
          jsonEncode({
            'items': [
              for (final MapEntry(:key, :value) in states.entries)
                document(key, value, error: value == 'failed' ? 'The file is encrypted.' : null),
            ],
            'total': states.length,
          }),
          200,
        );
      }
      if (request.method == 'POST' && path.endsWith('/ingestion-runs')) {
        runBodies.add(jsonDecode(request.body));
        return created.removeAt(0);
      }
      if (path.endsWith('/ingestion-runs/run')) {
        final status = runStatuses[runReads++];
        if (status == 'completed') states = {'pending': 'pending', 'failed': 'ready'};
        return http.Response(jsonEncode({'id': 'run', 'status': status}), 200);
      }
      return http.Response('{"detail":"unexpected ${request.method} $path"}', 500);
    }),
  )..accessToken = 'token';

  Widget list({required Set<String> permissions}) => MaterialApp(
    home: Scaffold(
      body: DocumentList(
        api: api,
        can: (permission, _) => permissions.contains(permission),
        collectionId: 'collection',
        onAskDocument: (_, _) {},
        empty: const Text('Empty'),
      ),
    ),
  );
}

void main() {
  testWidgets(
    'collection Process asks for pending and outdated documents and shows a 409 as the server says',
    (tester) async {
      final fake = FakeLibrary(
        created: [
          http.Response(
            '{"detail":"Nothing to process: the selected documents are already processed or being processed."}',
            409,
          ),
        ],
      );
      await tester.pumpWidget(fake.list(permissions: {'ingestion.run'}));
      await tester.pumpAndSettle();
      expect(find.text('Pending'), findsOneWidget);
      expect(find.text('Failed'), findsOneWidget);
      // Failed documents are retried one by one, not picked up by the collection.
      expect(find.text('1 document is not processed yet'), findsOneWidget);

      await tester.tap(find.text('Process'));
      await tester.pumpAndSettle();
      expect(fake.runBodies, [
        {
          'collection_id': 'collection',
          'states': ['pending', 'outdated'],
          'trigger': 'manual',
        },
      ]);
      expect(
        find.text('Nothing to process: the selected documents are already processed or being processed.'),
        findsOneWidget,
      );
      // Nothing is processing and no run started: the list does not poll.
      expect(fake.documentReads, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      fake.api.close();
    },
  );

  testWidgets(
    'retrying a failed document starts a run for it and follows the run until it finishes',
    (tester) async {
      final fake = FakeLibrary(
        created: [http.Response('{"id":"run","status":"queued"}', 202)],
        runStatuses: ['queued', 'completed'],
      );
      await tester.pumpWidget(fake.list(permissions: {'ingestion.run'}));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('More').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry processing'));
      await tester.pumpAndSettle();
      expect(fake.runBodies, [
        {
          'document_ids': ['failed'],
          'trigger': 'manual',
        },
      ]);
      // The run is still queued, so the list refreshes again.
      expect(fake.documentReads, 2);
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(fake.documentReads, 3);
      expect(find.text('Failed'), findsNothing);
      // The run finished and nothing is processing: no further refresh is
      // scheduled (a pending timer would fail the test at teardown).
      await tester.pump(const Duration(seconds: 10));
      expect(fake.documentReads, 3);
      await tester.pumpWidget(const SizedBox.shrink());
      fake.api.close();
    },
  );

  testWidgets('without ingestion.run nothing offers processing', (tester) async {
    final fake = FakeLibrary(created: []);
    await tester.pumpWidget(fake.list(permissions: {}));
    await tester.pumpAndSettle();
    expect(find.text('Process'), findsNothing);
    await tester.tap(find.byTooltip('More').last);
    await tester.pumpAndSettle();
    expect(find.text('Retry processing'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    fake.api.close();
  });
}
