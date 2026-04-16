#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <napi.h>

// Helper function to perform OCR using Vision API
NSArray* performOCROnImage(NSData* imageData, NSArray* keywords) {
    NSMutableArray* results = [NSMutableArray array];

    @autoreleasepool {
        // Create CGImage from data
        NSImage* image = [[NSImage alloc] initWithData:imageData];
        if (!image) {
            return results;
        }

        CGImageRef cgImage = [image CGImageForProposedRect:NULL context:NULL hints:NULL];
        if (!cgImage) {
            return results;
        }

        // Create Vision request with optimized settings for speed
        VNRecognizeTextRequest* request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelFast;
        request.usesLanguageCorrection = NO;
        request.minimumTextHeight = 0.0;

        // Set recognition languages (English + common languages)
        if (@available(macOS 11.0, *)) {
            request.recognitionLanguages = @[@"en-US"];
        }

        // Use automatic language detection
        if (@available(macOS 13.0, *)) {
            request.automaticallyDetectsLanguage = YES;
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
                        NSDictionary* result = @{
                            @"text": [text substringWithRange:foundRange],
                            @"keyword": keyword,
                            @"x": @(boundingBox.origin.x),
                            @"y": @(1.0 - boundingBox.origin.y - boundingBox.size.height),
                            @"width": @(boundingBox.size.width),
                            @"height": @(boundingBox.size.height)
                        };

                        [results addObject:result];

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

                            NSDictionary* result = @{
                                @"text": [text substringWithRange:foundRange],
                                @"keyword": keyword,
                                @"x": @(boundingBox.origin.x),
                                @"y": @(1.0 - boundingBox.origin.y - boundingBox.size.height),
                                @"width": @(boundingBox.size.width),
                                @"height": @(boundingBox.size.height)
                            };

                            [results addObject:result];
                        }
                    }
                }
            }
        }
    }

    return results;
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
        results = [performOCROnImage(imageData, keywords) retain];
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        Napi::Array jsResults = Napi::Array::New(Env());

        for (NSUInteger i = 0; i < [results count]; i++) {
            NSDictionary* result = results[i];
            Napi::Object jsResult = Napi::Object::New(Env());

            NSString* text = result[@"text"];
            NSString* keyword = result[@"keyword"];
            jsResult.Set("text", Napi::String::New(Env(), [text UTF8String]));
            jsResult.Set("keyword", Napi::String::New(Env(), [keyword UTF8String]));
            jsResult.Set("x", Napi::Number::New(Env(), [result[@"x"] doubleValue]));
            jsResult.Set("y", Napi::Number::New(Env(), [result[@"y"] doubleValue]));
            jsResult.Set("width", Napi::Number::New(Env(), [result[@"width"] doubleValue]));
            jsResult.Set("height", Napi::Number::New(Env(), [result[@"height"] doubleValue]));

            jsResults[i] = jsResult;
        }

        Callback().Call({Env().Null(), jsResults});
        [results release];
    }

private:
    NSData* imageData;
    NSArray* keywords;
    NSArray* results;
};

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
                    if (name && ([name containsString:@"Overlay"] || [name containsString:@"keywords-highlighter"])) {
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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("performOCR", Napi::Function::New(env, PerformOCR));
    exports.Set("getFrontWindowBounds", Napi::Function::New(env, GetFrontWindowBounds));
    return exports;
}

NODE_API_MODULE(ocr, Init)
