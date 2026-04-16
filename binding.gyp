{
  "targets": [
    {
      "target_name": "ocr",
      "sources": [
        "src/native/ocr_bridge.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "xcode_settings": {
        "OTHER_CFLAGS": [
          "-x objective-c++",
          "-std=c++17"
        ],
        "OTHER_LDFLAGS": [
          "-framework Vision",
          "-framework CoreGraphics",
          "-framework Foundation",
          "-framework AppKit"
        ],
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      }
    }
  ]
}
