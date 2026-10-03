import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../features/auth/auth_page.dart';
import '../features/auth/session.dart';
import 'app_brand.dart';
import 'app_theme.dart';
import 'workspace_shell.dart';

class ProductApp extends StatefulWidget {
  const ProductApp({super.key});

  @override
  State<ProductApp> createState() => _ProductAppState();
}

class _ProductAppState extends State<ProductApp> with WidgetsBindingObserver {
  late final ApiClient _api;
  late final SessionController _auth;

  @override
  void initState() {
    super.initState();
    _api = ApiClient();
    _auth = SessionController(_api);
    WidgetsBinding.instance.addObserver(this);
    unawaited(_auth.restore());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_auth.refresh().catchError((Object _) {}));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.dispose();
    _api.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppBrand.productName,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      home: AnimatedBuilder(
        animation: _auth,
        builder: (context, _) {
          if (_auth.restoring) {
            return const Scaffold(
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(height: 20),
                    Text('Opening your workspace…'),
                  ],
                ),
              ),
            );
          }
          final session = _auth.session;
          return Navigator(
            key: ValueKey(
              session == null
                  ? 'signed-out'
                  : '${session.namespace}:${session.accessToken}',
            ),
            pages: [
              MaterialPage<void>(
                name: session == null ? '/sign-in' : '/workspace',
                child: session == null
                    ? AuthPage(controller: _auth)
                    : WorkspaceShell(
                        api: _api,
                        auth: _auth,
                      ),
              ),
            ],
            onDidRemovePage: (_) {},
          );
        },
      ),
    );
  }
}
