import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../app/app_config.dart';
import 'session.dart';
import 'google_button_native.dart'
    if (dart.library.js_interop) 'google_button_web.dart'
    as platform;

Future<void>? _initialization;

class GoogleLogin extends StatefulWidget {
  const GoogleLogin({super.key, required this.controller});
  final SessionController controller;
  @override
  State<GoogleLogin> createState() => _GoogleLoginState();
}

class _GoogleLoginState extends State<GoogleLogin> {
  StreamSubscription<GoogleSignInAuthenticationEvent>? _subscription;
  bool _ready = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      await (_initialization ??= GoogleSignIn.instance.initialize(
        clientId: AppConfig.googleClientId.isEmpty
            ? null
            : AppConfig.googleClientId,
        serverClientId: kIsWeb || AppConfig.googleServerClientId.isEmpty
            ? null
            : AppConfig.googleServerClientId,
      ));
      if (!mounted) return;
      _subscription = GoogleSignIn.instance.authenticationEvents.listen(
        (event) {
          if (event is GoogleSignInAuthenticationEventSignIn) {
            final token = event.user.authentication.idToken;
            if (token == null) {
              setState(
                () => _error = 'Google did not return a sign-in credential.',
              );
            } else {
              unawaited(widget.controller.google(token));
            }
          }
        },
        onError: (Object error) {
          if (mounted) setState(() => _error = error.toString());
        },
      );
      setState(() => _ready = true);
    } catch (_) {
      _initialization = null;
      if (mounted) {
        setState(
          () => _error = 'Google sign-in could not start. Check the app’s Google client configuration.',
        );
      }
    }
  }

  Future<void> _signIn() async {
    try {
      await GoogleSignIn.instance.authenticate();
    } on GoogleSignInException catch (error) {
      if (error.code != GoogleSignInExceptionCode.canceled && mounted) {
        setState(
          () => _error = 'Google sign-in failed. Try again or use your email.',
        );
      }
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (_ready)
        IgnorePointer(
          ignoring: widget.controller.busy,
          child: platform.googleButton(onPressed: _signIn),
        ),
      if (!_ready && _error == null)
        const Center(child: CircularProgressIndicator()),
      if (_error != null)
        Text(
          _error!,
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
    ],
  );
}
