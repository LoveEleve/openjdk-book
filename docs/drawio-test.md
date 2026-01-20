# Draw.io 功能测试

这是一个测试draw.io功能的示例文档。

## 简单流程图示例

```drawio
<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
      <mxGeometry x="364" y="40" width="100" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="处理数据" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="354" y="140" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="4" value="判断条件" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
      <mxGeometry x="354" y="240" width="120" height="80" as="geometry"/>
    </mxCell>
    <mxCell id="5" value="结束" style="ellipse;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1">
      <mxGeometry x="364" y="360" width="100" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="6" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="2" target="3">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="250" as="sourcePoint"/>
        <mxPoint x="440" y="200" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
    <mxCell id="7" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="3" target="4">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="250" as="sourcePoint"/>
        <mxPoint x="440" y="200" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
    <mxCell id="8" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="4" target="5">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="350" as="sourcePoint"/>
        <mxPoint x="440" y="300" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
  </root>
</mxGraphModel>
```

## 系统架构图示例

```drawio
<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="用户界面" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;" vertex="1" parent="1">
      <mxGeometry x="320" y="40" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="业务逻辑层" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="320" y="140" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="4" value="数据访问层" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
      <mxGeometry x="320" y="240" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="5" value="数据库" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
      <mxGeometry x="350" y="340" width="60" height="80" as="geometry"/>
    </mxCell>
    <mxCell id="6" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="2" target="3">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="250" as="sourcePoint"/>
        <mxPoint x="440" y="200" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
    <mxCell id="7" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="3" target="4">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="250" as="sourcePoint"/>
        <mxPoint x="440" y="200" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
    <mxCell id="8" value="" style="endArrow=classic;html=1;rounded=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=15;" edge="1" parent="1" source="4" target="5">
      <mxGeometry width="50" height="50" relative="1" as="geometry">
        <mxPoint x="390" y="350" as="sourcePoint"/>
        <mxPoint x="440" y="300" as="targetPoint"/>
      </mxGeometry>
    </mxCell>
  </root>
</mxGraphModel>
```

## 使用说明

1. **查看图表**：上面的图表会自动渲染显示
2. **在线编辑**：点击图表下方的"📝 用 Draw.io 打开"按钮
3. **编辑功能**：
   - 按钮会打开 app.diagrams.net（draw.io官网）
   - 自动加载当前图表内容
   - 可以在线编辑、修改图表
   - 编辑完成后可以导出新的XML代码
   - 将新代码替换到markdown文件中即可

## 现有PNG图片

现有的PNG图片不受影响，仍然正常显示：

![示例图片](https://via.placeholder.com/400x200/4CAF50/white?text=现有PNG图片正常显示)

---

**注意**：这个功能让读者可以方便地查看和编辑技术图表，非常适合技术博客使用！