; ModuleID = 'example.c'
source_filename = "example.c"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

%struct.Point = type { i32, i32, [4 x i8] }
%"weird name" = type opaque

@.str = private unnamed_addr constant [13 x i8] c"hello %d\0A\00", align 1
@counter = dso_local global i64 0, align 8
@"quoted global" = internal thread_local global double 3.500000e+00
@alias.to.counter = alias i64, ptr @counter

declare i32 @printf(ptr noundef, ...) #1

define dso_local noundef i32 @classify(i32 noundef %n, ptr nocapture readonly %p) #0 {
entry:
  %cmp = icmp sgt i32 %n, 0
  br i1 %cmp, label %positive, label %check.zero

positive:                                         ; preds = %entry
  %scaled = mul nsw i32 %n, 7
  %vec = insertelement <4 x i32> undef, i32 %scaled, i64 0
  %sum = add nuw nsw i32 %scaled, 1
  br label %exit

check.zero:                                       ; preds = %entry
  switch i32 %n, label %negative [
    i32 0, label %zero
    i32 -1, label %negative
  ]

zero:                                             ; preds = %check.zero
  %loaded = load i64, ptr @counter, align 8, !tbaa !5
  %conv = trunc i64 %loaded to i32
  br label %exit

negative:                                         ; preds = %check.zero, %check.zero
  %field = getelementptr inbounds %struct.Point, ptr %p, i32 0, i32 1
  %old = atomicrmw add ptr @counter, i64 1 seq_cst, align 8
  %call = tail call i32 (ptr, ...) @printf(ptr noundef @.str, i32 noundef %n)
  br label %exit

exit:                                             ; preds = %negative, %zero, %positive
  %result = phi i32 [ %sum, %positive ], [ %conv, %zero ], [ -1, %negative ]
  %fp = sitofp i32 %result to double
  %ok = fcmp fast oge double %fp, 0x400921FB54442D18
  %sel = select i1 %ok, i32 %result, i32 0, !dbg !12
  ret i32 %sel, !dbg !12
}

define linkonce_odr hidden fastcc void @maybe_throw() unnamed_addr #2 personality ptr @__gxx_personality_v0 {
  invoke void @maybe_throw()
          to label %done unwind label %lpad

lpad:
  %lp = landingpad { ptr, i32 }
          cleanup
  resume { ptr, i32 } %lp

done:
  unreachable
}

declare i32 @__gxx_personality_v0(...)

attributes #0 = { nounwind willreturn memory(read) "frame-pointer"="all" }
attributes #1 = { nofree nounwind "no-trapping-math"="true" }
attributes #2 = { noinline optnone uwtable }

!llvm.module.flags = !{!0, !1}
!llvm.ident = !{!4}

!0 = !{i32 7, !"Dwarf Version", i32 5}
!1 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{!"clang version 18.1.0"}
!5 = !{!6, !6, i64 0}
!6 = !{!"long", !7, i64 0}
!7 = !{!"omnipotent char", !8, i64 0}
!8 = !{!"Simple C/C++ TBAA"}
!9 = distinct !DICompileUnit(language: DW_LANG_C11, file: !10, producer: "clang", isOptimized: true, emissionKind: FullDebug)
!10 = !DIFile(filename: "example.c", directory: "/tmp")
!11 = distinct !DISubprogram(name: "classify", scope: !10, file: !10, line: 3, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !9)
!12 = !DILocation(line: 9, column: 3, scope: !11)
