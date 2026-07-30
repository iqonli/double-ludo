#!/usr/bin/env python3
"""Export the deployment policy from an SB3 MaskablePPO zip to ai-model-normal.js."""
from __future__ import annotations
import argparse, base64, io, json, zipfile
from pathlib import Path
import numpy as np
import torch

KEYS = {
    'w1': 'mlp_extractor.policy_net.0.weight',
    'b1': 'mlp_extractor.policy_net.0.bias',
    'w2': 'mlp_extractor.policy_net.2.weight',
    'b2': 'mlp_extractor.policy_net.2.bias',
    'w3': 'mlp_extractor.policy_net.4.weight',
    'b3': 'mlp_extractor.policy_net.4.bias',
    'wa': 'action_net.weight',
    'ba': 'action_net.bias',
}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('model_zip', type=Path)
    ap.add_argument('output_js', type=Path)
    ap.add_argument('--id', default='normal-v1')
    ap.add_argument('--label', default='正常')
    ap.add_argument('--global-name', default='')
    args=ap.parse_args()
    with zipfile.ZipFile(args.model_zip) as z:
        state=torch.load(io.BytesIO(z.read('policy.pth')),map_location='cpu',weights_only=False)
        data=json.loads(z.read('data'))
    tensors={}
    shapes={}
    for short,key in KEYS.items():
        array=state[key].detach().cpu().numpy().astype('<f4',copy=False)
        shapes[short]=list(array.shape)
        tensors[short]=base64.b64encode(array.tobytes(order='C')).decode('ascii')
    metadata={
        'id':args.id,'label':args.label,'source':args.model_zip.name,
        'observationDim':shapes['w1'][1],'actionDim':shapes['wa'][0],
        'hidden':[shapes['w1'][0],shapes['w2'][0],shapes['w3'][0]],
        'activation':'relu','dtype':'float32-le','shapes':shapes,
        'numTimesteps':int(data.get('num_timesteps',0)),'deterministic':True,
    }
    global_name=args.global_name or ('DoubleFlightAIModelAdvanced' if args.id.startswith('advanced') else 'DoubleFlightAIModelNormal')
    text="(function(root){\n'use strict';\n"
    text+=f"const metadata={json.dumps(metadata,separators=(',',':'),ensure_ascii=True)};\n"
    text+=f"const tensors={json.dumps(tensors,separators=(',',':'))};\n"
    text+=f"root.{global_name}={{metadata,tensors}};\n}})(typeof globalThis!=='undefined'?globalThis:this);\n"
    args.output_js.write_text(text,encoding='utf-8')
    print(json.dumps(metadata,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
