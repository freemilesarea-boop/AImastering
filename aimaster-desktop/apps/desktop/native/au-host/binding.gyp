{
  "targets": [
    {
      "target_name": "au_host",
      "sources": [ "src/au_host.mm" ],
      "include_dirs": [ "<!@(node -p \"require('node-addon-api').include_dir\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS==\"mac\"", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": [ "-std=c++17", "-ObjC++" ]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/AudioToolbox.framework",
              "$(SDKROOT)/System/Library/Frameworks/AudioUnit.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreAudio.framework",
              "$(SDKROOT)/System/Library/Frameworks/Foundation.framework"
            ]
          }
        }]
      ]
    }
  ]
}
