#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <unistd.h>
#import <napi.h>

#include <string>
#include <vector>

// Builds a CGImage over tightly packed 8-bit-per-channel rows, the layout produced by
// Electron's NativeImage.toBitmap() (BGRA) or by a canvas ImageData read (RGBA).
// No pixel copy is made: the caller owns the data and must keep it alive while the image is used.
CGImageRef createRawImage(const uint8_t* data, size_t width, size_t height, bool bgra) {
    if (!data || width == 0 || height == 0) {
        return NULL;
    }

    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, (void*)data, width * height * 4, NULL);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGImageRef image = CGImageCreate(
        width,
        height,
        8,
        32,
        width * 4,
        colorSpace,
        bgra ? (kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst)
             : (kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast),
        provider,
        NULL,
        false,
        kCGRenderingIntentDefault
    );
    CGColorSpaceRelease(colorSpace);
    CGDataProviderRelease(provider);
    return image;
}

// A keyword match, in plain C++ so results can safely outlive the autorelease pool
// they were produced in.
struct OCRMatch {
    std::string text;
    std::string keyword;
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
};

// How a recognition request should be configured. The live capture path tunes these for
// latency (fast level for the preview pass, pinned languages to skip language detection).
struct OCROptions {
    VNRequestTextRecognitionLevel level = VNRequestTextRecognitionLevelAccurate;
    bool automaticallyDetectsLanguage = true;
    bool bgra = true;
    NSArray* languages = nil;
};

// Runs Vision on an already decoded image and collects keyword matches.
std::vector<OCRMatch> matchKeywordsInImage(CGImageRef cgImage, NSArray* keywords, const OCROptions& options) {
    std::vector<OCRMatch> results;

    @autoreleasepool {
        if (!cgImage) {
            return results;
        }

        VNRecognizeTextRequest* request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = options.level;
        request.usesLanguageCorrection = NO;
        request.minimumTextHeight = 0.0;

        if (options.languages.count > 0) {
            if (@available(macOS 11.0, *)) {
                request.recognitionLanguages = options.languages;
            }
        }

        if (@available(macOS 13.0, *)) {
            request.automaticallyDetectsLanguage = options.automaticallyDetectsLanguage;
        }

        // Create request handler
        VNImageRequestHandler* handler = [[VNImageRequestHandler alloc]
            initWithCGImage:cgImage options:@{}];

        NSError* error = nil;
        [handler performRequests:@[request] error:&error];

        if (error) {
            NSLog(@"Vision error: %@", error);
            return results;
        }

        // Process results and find keyword matches
        NSArray<VNRecognizedTextObservation*>* observations = request.results;

        for (VNRecognizedTextObservation* observation in observations) {
            // Get top candidate only for speed
            NSArray<VNRecognizedText*>* candidates = [observation topCandidates:1];

            for (VNRecognizedText* recognizedText in candidates) {
                if (!recognizedText) continue;

                NSString* text = recognizedText.string;

                // Search for each keyword in text (case-insensitive, all occurrences)
                for (NSString* keyword in keywords) {
                    // Determine if keyword contains non-ASCII (CJK/Chinese) characters
                    BOOL hasCJK = NO;
                    for (NSUInteger ci = 0; ci < keyword.length; ci++) {
                        unichar ch = [keyword characterAtIndex:ci];
                        if (ch > 0x7F) { hasCJK = YES; break; }
                    }

                    if (hasCJK) {
                        // CJK keyword: plain substring match
                        NSRange searchRange = NSMakeRange(0, text.length);
                        while (searchRange.location < text.length) {
                            NSRange foundRange = [text rangeOfString:keyword
                                                             options:NSCaseInsensitiveSearch
                                                               range:searchRange];
                            if (foundRange.location == NSNotFound) break;
                        // Get precise bounding box for the keyword substring
                        NSError* boxError = nil;
                        VNRectangleObservation* keywordBox = [recognizedText boundingBoxForRange:foundRange error:&boxError];

                        CGRect boundingBox;
                        if (keywordBox && !boxError) {
                            // Use precise keyword bounding box
                            boundingBox = keywordBox.boundingBox;
                        } else {
                            // Fallback to full text bounding box
                            boundingBox = observation.boundingBox;
                        }

                        // Vision coordinates: (0,0) at bottom-left, normalized 0-1
                        // Convert to top-left origin for screen coordinates
                        results.push_back({
                            [text substringWithRange:foundRange].UTF8String,
                            keyword.UTF8String,
                            boundingBox.origin.x,
                            1.0 - boundingBox.origin.y - boundingBox.size.height,
                            boundingBox.size.width,
                            boundingBox.size.height
                        });

                        // Move search range past this match
                        searchRange.location = foundRange.location + foundRange.length;
                        searchRange.length = text.length - searchRange.location;
                    }
                    } else {
                        // ASCII keyword: use word boundary regex
                        NSString* pattern = [NSString stringWithFormat:@"\\b%@\\b",
                                            [NSRegularExpression escapedPatternForString:keyword]];
                        NSError* regexError = nil;
                        NSRegularExpression* regex = [NSRegularExpression regularExpressionWithPattern:pattern
                                                                                               options:NSRegularExpressionCaseInsensitive
                                                                                                 error:&regexError];
                        if (regexError) continue;

                        NSArray<NSTextCheckingResult*>* regexMatches = [regex matchesInString:text
                                                                                       options:0
                                                                                         range:NSMakeRange(0, text.length)];
                        for (NSTextCheckingResult* regexMatch in regexMatches) {
                            NSRange foundRange = regexMatch.range;

                            NSError* boxError = nil;
                            VNRectangleObservation* keywordBox = [recognizedText boundingBoxForRange:foundRange error:&boxError];

                            CGRect boundingBox;
                            if (keywordBox && !boxError) {
                                boundingBox = keywordBox.boundingBox;
                            } else {
                                boundingBox = observation.boundingBox;
                            }

                            results.push_back({
                                [text substringWithRange:foundRange].UTF8String,
                                keyword.UTF8String,
                                boundingBox.origin.x,
                                1.0 - boundingBox.origin.y - boundingBox.size.height,
                                boundingBox.size.width,
                                boundingBox.size.height
                            });
                        }
                    }
                }
            }
        }
    }

    return results;
}

// Helper function to perform OCR on an encoded image (PNG/JPEG) using the Vision API
std::vector<OCRMatch> performOCROnImage(NSData* imageData, NSArray* keywords) {
    @autoreleasepool {
        NSImage* image = [[NSImage alloc] initWithData:imageData];
        if (!image) {
            return {};
        }

        CGImageRef cgImage = [image CGImageForProposedRect:NULL context:NULL hints:NULL];
        if (!cgImage) {
            return {};
        }

        // Imported images and PDFs are not latency sensitive, so they keep language detection
        // and the accurate level.
        OCROptions options;
        options.level = VNRequestTextRecognitionLevelAccurate;
        options.automaticallyDetectsLanguage = true;
        options.languages = @[@"en-US"];
        return matchKeywordsInImage(cgImage, keywords, options);
    }
}

// Copies keyword matches into a JS array of {text, keyword, x, y, width, height}.
Napi::Array matchesToJsArray(Napi::Env env, const std::vector<OCRMatch>& matches) {
    Napi::Array jsResults = Napi::Array::New(env, matches.size());

    for (size_t i = 0; i < matches.size(); i++) {
        const OCRMatch& match = matches[i];
        Napi::Object jsResult = Napi::Object::New(env);
        jsResult.Set("text", Napi::String::New(env, match.text));
        jsResult.Set("keyword", Napi::String::New(env, match.keyword));
        jsResult.Set("x", Napi::Number::New(env, match.x));
        jsResult.Set("y", Napi::Number::New(env, match.y));
        jsResult.Set("width", Napi::Number::New(env, match.width));
        jsResult.Set("height", Napi::Number::New(env, match.height));
        jsResults[i] = jsResult;
    }

    return jsResults;
}

// N-API wrapper
class PerformOCRWorker : public Napi::AsyncWorker {
public:
    PerformOCRWorker(Napi::Function& callback, NSData* imageData, NSArray* keywords)
        : Napi::AsyncWorker(callback), imageData([imageData retain]), keywords([keywords retain]) {}

    ~PerformOCRWorker() {
        [imageData release];
        [keywords release];
    }

    void Execute() override {
        results = performOCROnImage(imageData, keywords);
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        Callback().Call({Env().Null(), matchesToJsArray(Env(), results)});
    }

private:
    NSData* imageData;
    NSArray* keywords;
    std::vector<OCRMatch> results;
};

// Raw bitmap variant: takes the pixels straight from the screen capture, so the capture
// path never has to encode (and Vision never has to decode) an image.
class PerformOCRBitmapWorker : public Napi::AsyncWorker {
public:
    PerformOCRBitmapWorker(
        Napi::Function& callback,
        Napi::Buffer<uint8_t> bitmap,
        size_t width,
        size_t height,
        NSArray* keywords,
        const OCROptions& options
    )
        : Napi::AsyncWorker(callback), width(width), height(height), keywords([keywords retain]), options(options) {
        if (options.languages) {
            this->options.languages = [options.languages retain];
        }
        // The worker thread outlives the JS call, so own a copy of the pixels.
        size_t byteLength = width * height * 4;
        bitmapData = (uint8_t*)malloc(byteLength);
        memcpy(bitmapData, bitmap.Data(), byteLength);
    }

    ~PerformOCRBitmapWorker() {
        free(bitmapData);
        [keywords release];
        if (options.languages) {
            [options.languages release];
        }
    }

    void Execute() override {
        @autoreleasepool {
            CGImageRef image = createRawImage(bitmapData, width, height, options.bgra);
            results = matchKeywordsInImage(image, keywords, options);
            if (image) {
                CGImageRelease(image);
            }
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        Callback().Call({Env().Null(), matchesToJsArray(Env(), results)});
    }

private:
    uint8_t* bitmapData;
    size_t width;
    size_t height;
    NSArray* keywords;
    OCROptions options;
    std::vector<OCRMatch> results;
};

Napi::Value PerformOCRBitmap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 6 || !info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber()
        || !info[3].IsArray() || !info[4].IsObject() || !info[5].IsFunction()) {
        Napi::TypeError::New(env, "Expected (bitmap: Buffer, width: number, height: number, keywords: Array, options: object, callback: Function)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> bitmap = info[0].As<Napi::Buffer<uint8_t>>();
    size_t width = (size_t)info[1].As<Napi::Number>().Int64Value();
    size_t height = (size_t)info[2].As<Napi::Number>().Int64Value();
    Napi::Array keywordsArray = info[3].As<Napi::Array>();
    Napi::Object optionsObject = info[4].As<Napi::Object>();
    Napi::Function callback = info[5].As<Napi::Function>();

    if (width == 0 || height == 0 || bitmap.Length() < width * height * 4) {
        Napi::TypeError::New(env, "Bitmap buffer is smaller than width * height * 4 bytes").ThrowAsJavaScriptException();
        return env.Null();
    }

    NSMutableArray* keywords = [NSMutableArray array];
    for (uint32_t i = 0; i < keywordsArray.Length(); i++) {
        Napi::Value val = keywordsArray[i];
        if (val.IsString()) {
            std::string keyword = val.As<Napi::String>().Utf8Value();
            if (!keyword.empty()) {
                [keywords addObject:[NSString stringWithUTF8String:keyword.c_str()]];
            }
        }
    }

    OCROptions options;
    options.level = VNRequestTextRecognitionLevelAccurate;
    options.automaticallyDetectsLanguage = true;
    options.bgra = true;

    if (optionsObject.Has("level") && optionsObject.Get("level").IsString()) {
        std::string level = optionsObject.Get("level").As<Napi::String>().Utf8Value();
        options.level = (level == "fast") ? VNRequestTextRecognitionLevelFast : VNRequestTextRecognitionLevelAccurate;
    }
    if (optionsObject.Has("pixelFormat") && optionsObject.Get("pixelFormat").IsString()) {
        std::string format = optionsObject.Get("pixelFormat").As<Napi::String>().Utf8Value();
        options.bgra = (format != "rgba");
    }
    if (optionsObject.Has("automaticallyDetectsLanguage") && optionsObject.Get("automaticallyDetectsLanguage").IsBoolean()) {
        options.automaticallyDetectsLanguage = optionsObject.Get("automaticallyDetectsLanguage").As<Napi::Boolean>().Value();
    }
    if (optionsObject.Has("languages") && optionsObject.Get("languages").IsArray()) {
        Napi::Array languagesArray = optionsObject.Get("languages").As<Napi::Array>();
        NSMutableArray* languages = [NSMutableArray array];
        for (uint32_t i = 0; i < languagesArray.Length(); i++) {
            Napi::Value val = languagesArray[i];
            if (val.IsString()) {
                std::string language = val.As<Napi::String>().Utf8Value();
                if (!language.empty()) {
                    [languages addObject:[NSString stringWithUTF8String:language.c_str()]];
                }
            }
        }
        options.languages = languages;
    }

    PerformOCRBitmapWorker* worker = new PerformOCRBitmapWorker(callback, bitmap, width, height, keywords, options);
    worker->Queue();
    return env.Undefined();
}

Napi::Value PerformOCR(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsBuffer() || !info[1].IsArray() || !info[2].IsFunction()) {
        Napi::TypeError::New(env, "Expected (Buffer, Array, callback)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    Napi::Array keywordsArray = info[1].As<Napi::Array>();
    Napi::Function callback = info[2].As<Napi::Function>();

    // Convert Buffer to NSData
    NSData* imageData = [NSData dataWithBytes:buffer.Data() length:buffer.Length()];

    // Convert JS array to NSArray
    NSMutableArray* keywords = [NSMutableArray array];
    for (uint32_t i = 0; i < keywordsArray.Length(); i++) {
        Napi::Value val = keywordsArray[i];
        if (val.IsString()) {
            std::string keyword = val.As<Napi::String>().Utf8Value();
            [keywords addObject:[NSString stringWithUTF8String:keyword.c_str()]];
        }
    }

    // Create async worker
    PerformOCRWorker* worker = new PerformOCRWorker(callback, imageData, keywords);
    worker->Queue();

    return env.Undefined();
}

Napi::Value GetFrontWindowBounds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    @autoreleasepool {
        // Get list of all windows
        CFArrayRef windowList = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );

        if (windowList) {
            CFIndex count = CFArrayGetCount(windowList);

            for (CFIndex i = 0; i < count; i++) {
                CFDictionaryRef window = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);

                // Get window layer (0 = normal windows)
                CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(window, kCGWindowLayer);
                int layer = 0;
                if (layerRef) {
                    CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
                }

                // Skip non-normal windows
                if (layer != 0) continue;

                // Get window bounds
                CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(window, kCGWindowBounds);
                if (boundsRef) {
                    CGRect bounds;
                    CGRectMakeWithDictionaryRepresentation(boundsRef, &bounds);

                    // Get window name
                    CFStringRef nameRef = (CFStringRef)CFDictionaryGetValue(window, kCGWindowName);
                    NSString* name = (__bridge NSString*)nameRef;

                    // Skip our own overlay window
                    if (name && ([name containsString:@"Overlay"] || [name containsString:@"Perch"])) {
                        continue;
                    }

                    // This is the frontmost window
                    result.Set("x", Napi::Number::New(env, bounds.origin.x));
                    result.Set("y", Napi::Number::New(env, bounds.origin.y));
                    result.Set("width", Napi::Number::New(env, bounds.size.width));
                    result.Set("height", Napi::Number::New(env, bounds.size.height));
                    result.Set("name", Napi::String::New(env, name ? [name UTF8String] : ""));

                    CFRelease(windowList);
                    return result;
                }
            }

            CFRelease(windowList);
        }
    }

    // No window found, return null
    return env.Null();
}

Napi::Value GetFrontWindowContext(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    @autoreleasepool {
        CFArrayRef windowList = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );

        if (windowList) {
            CFIndex count = CFArrayGetCount(windowList);

            for (CFIndex i = 0; i < count; i++) {
                CFDictionaryRef window = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);

                CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(window, kCGWindowLayer);
                int layer = 0;
                if (layerRef) {
                    CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
                }
                if (layer != 0) continue;

                CFStringRef ownerNameRef = (CFStringRef)CFDictionaryGetValue(window, kCGWindowOwnerName);
                NSString* ownerName = (__bridge NSString*)ownerNameRef;

                CFStringRef windowNameRef = (CFStringRef)CFDictionaryGetValue(window, kCGWindowName);
                NSString* windowTitle = (__bridge NSString*)windowNameRef;

                NSString* combinedName = [NSString stringWithFormat:@"%@ %@", ownerName ?: @"", windowTitle ?: @""];
                if ([combinedName localizedCaseInsensitiveContainsString:@"Perch"]) {
                    continue;
                }

                CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(window, kCGWindowOwnerPID);
                pid_t pid = 0;
                if (pidRef) {
                    CFNumberGetValue(pidRef, kCFNumberIntType, &pid);
                }

                NSRunningApplication* app = pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
                NSString* appName = app.localizedName ?: ownerName ?: @"";
                NSString* bundleId = app.bundleIdentifier ?: @"";

                Napi::Object result = Napi::Object::New(env);
                result.Set("appName", Napi::String::New(env, [appName UTF8String]));
                result.Set("bundleId", Napi::String::New(env, [bundleId UTF8String]));
                result.Set("windowTitle", Napi::String::New(env, [(windowTitle ?: @"") UTF8String]));

                CFRelease(windowList);
                return result;
            }

            CFRelease(windowList);
        }
    }

    return env.Null();
}

Napi::Value SimulateCopyShortcut(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    @autoreleasepool {
        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        if (!source) {
            return Napi::Boolean::New(env, false);
        }

        CGEventRef commandDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)55, true);
        CGEventRef cDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)8, true);
        CGEventRef cUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)8, false);
        CGEventRef commandUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)55, false);

        if (!commandDown || !cDown || !cUp || !commandUp) {
            if (commandDown) CFRelease(commandDown);
            if (cDown) CFRelease(cDown);
            if (cUp) CFRelease(cUp);
            if (commandUp) CFRelease(commandUp);
            CFRelease(source);
            return Napi::Boolean::New(env, false);
        }

        CGEventSetFlags(cDown, kCGEventFlagMaskCommand);
        CGEventSetFlags(cUp, kCGEventFlagMaskCommand);

        CGEventPost(kCGHIDEventTap, commandDown);
        usleep(1000 * 10);
        CGEventPost(kCGHIDEventTap, cDown);
        usleep(1000 * 10);
        CGEventPost(kCGHIDEventTap, cUp);
        usleep(1000 * 10);
        CGEventPost(kCGHIDEventTap, commandUp);

        CFRelease(commandDown);
        CFRelease(cDown);
        CFRelease(cUp);
        CFRelease(commandUp);
        CFRelease(source);
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value ActivateAppByBundleId(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected (bundleId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string bundleIdValue = info[0].As<Napi::String>().Utf8Value();
    if (bundleIdValue.empty()) {
        return Napi::Boolean::New(env, false);
    }

    @autoreleasepool {
        NSString* bundleId = [NSString stringWithUTF8String:bundleIdValue.c_str()];
        NSArray<NSRunningApplication*>* apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
        for (NSRunningApplication* app in apps) {
            if (!app || app.terminated) continue;
            if (app.processIdentifier == [[NSRunningApplication currentApplication] processIdentifier]) {
                continue;
            }

            BOOL activated = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
            if (activated) {
                return Napi::Boolean::New(env, true);
            }
        }
    }

    return Napi::Boolean::New(env, false);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("performOCR", Napi::Function::New(env, PerformOCR));
    exports.Set("performOCRBitmap", Napi::Function::New(env, PerformOCRBitmap));
    exports.Set("getFrontWindowBounds", Napi::Function::New(env, GetFrontWindowBounds));
    exports.Set("getFrontWindowContext", Napi::Function::New(env, GetFrontWindowContext));
    exports.Set("simulateCopyShortcut", Napi::Function::New(env, SimulateCopyShortcut));
    exports.Set("activateAppByBundleId", Napi::Function::New(env, ActivateAppByBundleId));
    return exports;
}

NODE_API_MODULE(ocr, Init)
