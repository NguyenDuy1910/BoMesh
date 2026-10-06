import 'dart:async';

import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../features/auth/auth_page.dart';
import '../features/auth/session.dart';
import '../ui/ui.dart';
import 'app_brand.dart';
import 'appearance.dart';
import 'workspace_shell.dart';

class ProductApp extends StatefulWidget {
  const ProductApp({super.key});

  @override
  State<ProductApp> createState() => _ProductAppState();
}

class _ProductAppState extends State<ProductApp> with WidgetsBindingObserver {
  late final ApiClient _api;
  late final SessionController _auth;
  late final AppearanceController _appearance;
  final _rootNavigator = GlobalKey<NavigatorState>();
  String? _identity;

  @override
  void initState() {
    super.initState();
    _api = ApiClient();
    _auth = SessionController(_api);
    _appearance = AppearanceController();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_appearance.restore());
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
    _appearance.dispose();
    _api.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _appearance,
      builder: (context, _) => MaterialApp(
        navigatorKey: _rootNavigator,
        title: AppBrand.productName,
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: _appearance.mode,
        home: ListenableBuilder(
          listenable: _auth,
          builder: (context, _) {
            if (_auth.restoring) {
              return const Scaffold(
                body: LoadingView(label: 'Opening your workspace…'),
              );
            }
            final session = _auth.session;
            final identity = session == null
                ? 'signed-out'
                : '${session.namespace}:${session.accessToken}';
            if (identity != _identity) {
              // A new session (sign-in, sign-out, expiry, workspace switch)
              // starts clean: nothing opened for the previous one survives.
              _identity = identity;
              WidgetsBinding.instance.addPostFrameCallback(
                (_) => _rootNavigator.currentState?.popUntil(
                  (route) => route.isFirst,
                ),
              );
            }
            return KeyedSubtree(
              key: ValueKey(identity),
              child: session == null
                  ? AuthPage(controller: _auth)
                  : WorkspaceShell(
                      api: _api,
                      auth: _auth,
                      appearance: _appearance,
                    ),
            );
          },
        ),
      ),
    );
  }
}
