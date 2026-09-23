; Mistakes the built-in checks catch as you type, without LLVM installed.
declare i32 @printf(ptr, ...)
@message = private constant [4 x i8] c"%d\0A\00"

define i32 @average(i32 %first, i32 %second) {
entry:
  %sum = add i32 %first, %second
  %half = sdiv i32 %summ, 2
  ret i32 %half
}

define i32 @report(i32 %count) {
entry:
  %unused = mul i32 %count, 2
  %shown = call i32 @printf(ptr @message, i32 %count)
  ret i32 %count
}

define i32 @pick(i1 %flag) {
entry:
  br i1 %flag, label %yes, label %no
yes:
  %a = add i32 1, 2
  br label %join
no:
  br label %join
join:
  ret i32 %a
}
