import 'package:flutter/material.dart';

import '../../../app/app_brand.dart';

class ProductMark extends StatelessWidget {
  const ProductMark({super.key, this.size = 32});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: AppBrand.productName,
      image: true,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(size * 0.26),
          border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
        ),
        alignment: Alignment.center,
        child: Padding(
          padding: EdgeInsets.all(size * .08),
          child: Image.asset(
            'assets/bothesis-logo.png',
            excludeFromSemantics: true,
          ),
        ),
      ),
    );
  }
}
