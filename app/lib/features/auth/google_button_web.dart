import 'package:flutter/material.dart';
import 'package:google_sign_in_web/web_only.dart' as google;

// The plugin keys its rendered button by the configuration's identity, so one
// configuration per width keeps rebuilds from re-rendering Google's button.
final _configurations = <double, google.GSIButtonConfiguration>{};

/// Google's own rendered button (the only sign-in entry on the web), in its
/// outlined "Continue with Google" form, centred in the 52-high slot.
Widget googleButton({required VoidCallback onPressed}) => LayoutBuilder(
  builder: (context, constraints) {
    // Google caps its button at 400 px.
    final width = constraints.maxWidth.isFinite
        ? constraints.maxWidth.clamp(200, 400).roundToDouble()
        : 400.0;
    return SizedBox(
      height: 52,
      child: Center(
        child: google.renderButton(
          configuration: _configurations.putIfAbsent(
            width,
            () => google.GSIButtonConfiguration(
              type: google.GSIButtonType.standard,
              theme: google.GSIButtonTheme.outline,
              size: google.GSIButtonSize.large,
              text: google.GSIButtonText.continueWith,
              shape: google.GSIButtonShape.rectangular,
              logoAlignment: google.GSIButtonLogoAlignment.center,
              minimumWidth: width,
            ),
          ),
        ),
      ),
    );
  },
);
